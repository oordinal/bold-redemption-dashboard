const db = require('./db');

// A sender is flagged as a bot if it redeems through a contract or at least this often
const BOT_MIN_REDEMPTIONS = 3;
// On-chain prices (Uniswap ETH/USDC) count as distorted when they stray this far from the exchanges' price (exchange.js), or,
// for a redemption without an exchange price, from Liquity's oracle price
const DISTORTED_REFERENCE = 0.03;

// The figures shown for each redemption: the measured result (worker.js, actualResult) where it is available, the modelled
// one otherwise. Gas and builder payments are exact amounts of ETH, valued at Liquity's oracle price once it is recorded; the
// gross profit is then net profit + gas + builder payments. Oracle gap and BOLD discount stay estimates against reference prices.
// Where only the estimate exists, net profit is its gross profit less gas and builder payments at the same oracle price, so the
// parts of the Weekly breakdown always add up to the net profit shown. Redemptions without an estimate (dust below 1 BOLD, or no
// BOLD price at the time) show no profit either, as before.
//
// The market reference for the collateral is ETH's exchange price (cex_eth_usd) times each LST's rate: the collateral's value at
// the Uniswap reference (coll_market_price) scaled by exchange / Uniswap ETH price. From it come the oracle gap in % (gap_x_pct)
// and in USD (gap_x_usd: collateral at the exchange price minus at Liquity's redemption price), the edge (edge_x) and the gross
// profit estimated at reference prices (est_x: collateral at the exchange price minus the BOLD at its pool price). Without an
// exchange price, or with a branch lacking its Uniswap value, the Uniswap-based estimates stand.
const SHOWN = `SELECT c.*,
        CASE WHEN c.measured_s THEN c.actual_net_usd
             WHEN c.gross_profit_usd IS NOT NULL AND c.gas_s IS NOT NULL AND c.tip_s IS NOT NULL THEN c.gross_profit_usd - c.gas_s - c.tip_s
             ELSE c.net_profit_usd END AS net_s,
        COALESCE(c.gap_x_pct, c.oracle_gap) AS oracle_gap_s,
        COALESCE(c.edge_x, c.net_edge) AS edge_s,
        COALESCE(c.est_x, c.gross_profit_usd) AS est_s,
        -- averages and the decomposition leave out redemptions at distorted on-chain prices (such as 29 October 2026), whose effect
        -- the Weekly breakdown shows as the difference between on-chain and exchange prices
        NOT (CASE WHEN c.xf IS NOT NULL THEN ABS(c.eth_usd / c.cex_eth_usd - 1) >= ${DISTORTED_REFERENCE} ELSE c.distorted_old END) AS reliable,
        CASE WHEN c.xf IS NOT NULL THEN ABS(c.eth_usd / c.cex_eth_usd - 1) >= ${DISTORTED_REFERENCE} ELSE c.distorted_old END AS distorted
    FROM (SELECT b.*,
        b.cm * b.xf AS coll_x_usd,
        b.cm * b.xf - b.crp AS gap_x_usd,
        (b.gw * b.xf / b.bw - 1) * 100 AS gap_x_pct,
        CASE WHEN b.amount >= 1 AND b.market_price IS NOT NULL THEN (b.cm * b.xf / (b.amount * b.market_price) - 1) * 100 END AS edge_x,
        CASE WHEN b.amount >= 1 AND b.market_price IS NOT NULL THEN b.cm * b.xf - b.amount * b.market_price END AS est_x
    FROM (SELECT r.*, e.cm, e.crp, e.gw, e.bw,
        CASE WHEN r.cex_eth_usd IS NOT NULL AND r.eth_usd IS NOT NULL AND e.n = e.nm AND e.bw > 0 THEN r.cex_eth_usd / r.eth_usd END AS xf,
        CASE WHEN r.oracle_eth_usd IS NOT NULL AND r.base_fee_eth IS NOT NULL THEN r.base_fee_eth * r.oracle_eth_usd ELSE r.gas_fee_usd END AS gas_s,
        CASE WHEN r.oracle_eth_usd IS NOT NULL AND r.priority_fee_eth IS NOT NULL AND r.coinbase_tip_eth IS NOT NULL
             THEN (r.priority_fee_eth + r.coinbase_tip_eth) * r.oracle_eth_usd ELSE r.builder_tip_usd END AS tip_s,
        (r.oracle_eth_usd IS NOT NULL AND r.eth_usd IS NOT NULL AND ABS(r.eth_usd / r.oracle_eth_usd - 1) >= ${DISTORTED_REFERENCE}) AS distorted_old,
        (r.actual_status = 'measured' AND r.net_profit_usd IS NOT NULL) AS measured_s
        FROM redemptions r LEFT JOIN (
            SELECT tx_hash, SUM(coll_sent * coll_market_price) AS cm, SUM(coll_sent * redemption_price) AS crp,
                   SUM(CASE WHEN bold_redeemed > 0 THEN coll_market_price / redemption_price * bold_redeemed END) AS gw,
                   SUM(CASE WHEN bold_redeemed > 0 THEN bold_redeemed END) AS bw, COUNT(*) AS n, COUNT(coll_market_price) AS nm
            FROM redemption_events GROUP BY tx_hash) e USING (tx_hash)) b) c`;
const GROSS_S = `CASE WHEN measured_s THEN net_s + COALESCE(gas_s, 0) + COALESCE(tip_s, 0) ELSE gross_profit_usd END`;

const redemptionsQuery = db.prepare(`
    WITH counts AS (SELECT sender, COUNT(*) AS n FROM redemptions GROUP BY sender), s AS (${SHOWN})
    SELECT r.*, (r.via_contract OR c.n >= ${BOT_MIN_REDEMPTIONS}) AS is_bot
    FROM s r JOIN counts c USING (sender)
    ORDER BY r.block DESC, r.tx_hash
    LIMIT ?`);

const botsQuery = db.prepare(`
    WITH s AS (${SHOWN})
    SELECT sender AS address,
           COUNT(*) AS frequency,
           SUM(amount) AS total_bold,
           AVG(CASE WHEN reliable THEN edge_s END) AS avg_edge,
           SUM(net_s) AS net_profit_usd,
           MAX(via_contract) AS via_contract,
           MAX(timestamp) AS last_active
    FROM s
    GROUP BY sender
    HAVING MAX(via_contract) = 1 OR COUNT(*) >= ${BOT_MIN_REDEMPTIONS}
    ORDER BY net_profit_usd DESC, frequency DESC`);

// Averages of the reference-based estimates (discount, oracle gap, edge) cover the redemptions with a reliable reference
const statsQuery = db.prepare(`
    WITH s AS (${SHOWN})
    SELECT COUNT(*) AS tx_count,
           COALESCE(SUM(amount), 0) AS total_bold,
           COUNT(DISTINCT sender) AS senders,
           SUM(CASE WHEN reliable THEN spread * amount END) / SUM(CASE WHEN spread IS NOT NULL AND reliable THEN amount END) AS avg_spread,
           SUM(CASE WHEN reliable THEN oracle_gap_s * amount END) / SUM(CASE WHEN oracle_gap_s IS NOT NULL AND reliable THEN amount END) AS avg_oracle_gap,
           SUM(CASE WHEN reliable THEN edge_s * amount END) / SUM(CASE WHEN edge_s IS NOT NULL AND reliable THEN amount END) AS avg_edge,
           SUM(fee_usd) * 100 / SUM(amount) AS avg_fee,
           SUM(${GROSS_S}) AS gross_profit_usd,
           SUM(net_s) AS net_profit_usd,
           SUM(gas_s) AS gas_fee_usd,
           SUM(tip_s) AS builder_tip_usd,
           SUM(net_s) * 100 / SUM(CASE WHEN net_s IS NOT NULL THEN amount * market_price END) AS avg_margin,
           SUM(CASE WHEN measured_s THEN 1 ELSE 0 END) AS measured_count,
           SUM(CASE WHEN distorted THEN 1 ELSE 0 END) AS distorted_count,
           SUM(CASE WHEN xf IS NOT NULL THEN 1 ELSE 0 END) AS exchange_count,
           -- the same totals over the redemptions with a reliable reference only, for the methodology's decomposition (ref_*)
           SUM(CASE WHEN net_s IS NOT NULL THEN 1 ELSE 0 END) AS priced_count,
           SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN 1 ELSE 0 END) AS ref_count,
           SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN amount END) AS ref_bold,
           SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN fee_usd END) * 100 / SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN amount END) AS ref_avg_fee,
           SUM(CASE WHEN reliable THEN ${GROSS_S} END) AS ref_gross_usd,
           SUM(CASE WHEN reliable THEN net_s END) AS ref_net_usd,
           SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN gas_s END) AS ref_gas_usd,
           SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN tip_s END) AS ref_tip_usd,
           -- the estimate's parts in USD over the same redemptions: BOLD discount, redemption fee and the gross profit estimated at
           -- reference prices (the oracle-gap edge is what remains of it), so that the decomposition reconciles exactly with the
           -- measured gross profit; the step between them is the difference between on-chain and exchange prices
           SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN amount * (1 - market_price) END) AS ref_discount_usd,
           SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN fee_usd END) AS ref_fee_usd,
           SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN est_s END) AS ref_gross_model_usd,
           SUM(CASE WHEN reliable THEN net_s END) * 100 / SUM(CASE WHEN reliable AND net_s IS NOT NULL THEN amount * market_price END) AS ref_margin,
           MAX(timestamp) AS last_redemption
    FROM s`);

// Troves redeemed while a batch manager (interest-rate delegate) set their rate. A trove redeemed several times counts
// as batch-managed if it was in a batch at any of those redemptions.
const batchTotalsQuery = db.prepare(`
    WITH troves AS (SELECT MAX(batch_manager IS NOT NULL) AS batched FROM redemption_troves GROUP BY branch, trove_id)
    SELECT (SELECT COALESCE(SUM(debt_redeemed), 0) FROM redemption_troves) AS trove_bold,
           (SELECT COALESCE(SUM(debt_redeemed), 0) FROM redemption_troves WHERE batch_manager IS NOT NULL) AS batch_bold,
           (SELECT COUNT(*) FROM troves) AS troves,
           (SELECT COALESCE(SUM(batched), 0) FROM troves) AS batch_troves,
           -- a hit is a trove reached by a transaction (one transaction can make several redemption calls)
           (SELECT COUNT(DISTINCT tx_hash || branch || trove_id) FROM redemption_troves) AS hits,
           (SELECT COUNT(DISTINCT tx_hash || branch || trove_id) FROM redemption_troves WHERE batch_manager IS NOT NULL) AS batch_hits`);
const batchManagersQuery = db.prepare(`
    SELECT batch_manager AS address,
           COUNT(DISTINCT branch || trove_id) AS troves,
           COUNT(DISTINCT tx_hash) AS txs,
           SUM(debt_redeemed) AS bold
    FROM redemption_troves
    WHERE batch_manager IS NOT NULL
    GROUP BY batch_manager
    ORDER BY bold DESC`);

// Every trove redemption in compact form, so the page can compute the batch-managed figures for any time range:
// rows of [timestamp, tx index, trove index, manager index or -1, BOLD redeemed]; indexes point into txs/managers or
// only identify a trove (its id is not needed to count distinct troves)
const batchRowsQuery = db.prepare(`
    SELECT r.timestamp, t.tx_hash, t.branch || t.trove_id AS trove, t.batch_manager, t.debt_redeemed
    FROM redemption_troves t JOIN redemptions r USING (tx_hash)
    ORDER BY r.timestamp, t.tx_hash, t.log_index`);
function batchRows() {
    const indexer = () => { const m = new Map(); const idx = v => { if (!m.has(v)) m.set(v, m.size); return m.get(v); }; idx.keys = () => [...m.keys()]; return idx; };
    const txIdx = indexer(), troveIdx = indexer(), managerIdx = indexer();
    const rows = batchRowsQuery.all().map(r => [r.timestamp, txIdx(r.tx_hash), troveIdx(r.trove),
        r.batch_manager ? managerIdx(r.batch_manager) : -1, Math.round(r.debt_redeemed * 100) / 100]);
    return { managers: managerIdx.keys(), rows };
}

// Redeemer addresses with their contract deployer and ENS name, for grouping into operators
const addressesQuery = db.prepare('SELECT address, is_contract, deployer, ens FROM addresses ORDER BY address');

// Per-transaction detail: the branch-level Redemption events and the troves they touched
const txEventsQuery = db.prepare('SELECT * FROM redemption_events WHERE tx_hash = ? ORDER BY log_index');
const txTrovesQuery = db.prepare('SELECT * FROM redemption_troves WHERE tx_hash = ? ORDER BY log_index');
const allEventsQuery = db.prepare('SELECT * FROM redemption_events ORDER BY tx_hash, log_index');
const allTrovesQuery = db.prepare('SELECT * FROM redemption_troves ORDER BY tx_hash, log_index');

// Troves tab: the latest snapshot of every open trove (troves.js), and every redemption hit in compact form so the page
// can show a trove's or a batch manager's redemption record: rows of [timestamp, tx index, branch, trove index, BOLD debt
// repaid, collateral removed, fee left in the trove (collateral), manager index or -1, interest rate %, collateral market price]
const troveSnapshotQuery = db.prepare('SELECT data FROM trove_snapshot WHERE id = 1');
const troveHitsQuery = db.prepare(`
    SELECT r.timestamp, t.tx_hash, t.branch, t.trove_id, t.debt_redeemed, t.coll_redeemed, t.fee_coll, t.batch_manager, t.interest_rate,
           (SELECT CASE WHEN r.cex_eth_usd IS NOT NULL AND r.eth_usd IS NOT NULL AND MAX(e.coll_market_price) IS NOT NULL
                             THEN MAX(e.coll_market_price) * r.cex_eth_usd / r.eth_usd
                        WHEN r.oracle_eth_usd IS NOT NULL AND r.eth_usd IS NOT NULL AND ABS(r.eth_usd / r.oracle_eth_usd - 1) >= ${DISTORTED_REFERENCE}
                             THEN MAX(e.coll_price) ELSE MAX(e.coll_market_price) END
            FROM redemption_events e WHERE e.tx_hash = t.tx_hash AND e.branch = t.branch) AS market_price
    FROM redemption_troves t JOIN redemptions r USING (tx_hash)
    ORDER BY r.timestamp, t.tx_hash, t.log_index`);
function troveHits() {
    const indexer = () => { const m = new Map(); const idx = v => { if (!m.has(v)) m.set(v, m.size); return m.get(v); }; idx.keys = () => [...m.keys()]; return idx; };
    const txIdx = indexer(), troveIdx = indexer(), managerIdx = indexer();
    const round = (v, d) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
    const rows = troveHitsQuery.all().map(r => [r.timestamp, txIdx(r.tx_hash), r.branch, troveIdx(r.trove_id.toLowerCase()), round(r.debt_redeemed, 4),
        round(r.coll_redeemed, 8), round(r.fee_coll, 8), r.batch_manager ? managerIdx(r.batch_manager) : -1, round(r.interest_rate, 4), round(r.market_price, 4)]);
    return { txs: txIdx.keys(), troves: troveIdx.keys(), managers: managerIdx.keys(), rows };
}

function groupByTx(rows) {
    const map = new Map();
    for (const r of rows) {
        if (!map.has(r.tx_hash)) map.set(r.tx_hash, []);
        map.get(r.tx_hash).push(r);
    }
    return map;
}

// A redemption row as published: the shown figures under the usual names, the modelled ones kept as *_model_usd
function shownRow(r) {
    const measured = !!r.measured_s;
    const { gas_s, tip_s, net_s, distorted, measured_s, distorted_old, reliable, oracle_gap_s, edge_s, est_s, xf, cm, crp, gw, bw,
        coll_x_usd, gap_x_pct, edge_x, est_x, gap_x_usd, ...row } = r;
    const gross = measured ? net_s + (gas_s ?? 0) + (tip_s ?? 0) : r.gross_profit_usd;
    return { ...row, net_profit_model_usd: r.net_profit_usd, gross_profit_model_usd: r.gross_profit_usd,
        net_profit_usd: net_s, gross_profit_usd: gross, gas_fee_usd: gas_s, builder_tip_usd: tip_s,
        net_margin: net_s != null && r.amount && r.market_price ? net_s / (r.amount * r.market_price) * 100 : r.net_margin,
        measured: measured ? 1 : 0, ref_distorted: distorted ? 1 : 0, ref_reliable: reliable ? 1 : 0,
        // oracle gap and edge at the exchange reference where available (Uniswap-based ones kept as *_uniswap), and the oracle-gap
        // value in USD at the exchange price, null without it
        oracle_gap: oracle_gap_s, net_edge: edge_s, oracle_gap_uniswap: r.oracle_gap, net_edge_uniswap: r.net_edge,
        gap_x_usd: xf != null ? gap_x_usd : null };
}

module.exports = {
    redemptions: (limit = 5000) => redemptionsQuery.all(limit).map(shownRow),
    bots: () => botsQuery.all(),
    stats: () => ({ ...statsQuery.get(), ...batchTotalsQuery.get(), batch_managers: batchManagersQuery.all() }),
    batchRows,
    addresses: () => addressesQuery.all(),
    txDetail: hash => ({ events: txEventsQuery.all(hash), troves: txTrovesQuery.all(hash) }),
    troves: () => { const row = troveSnapshotQuery.get(); return row ? JSON.parse(row.data) : null; },
    troveHits,
    // Every transaction's detail at once, for the static export
    allTxDetails: () => {
        const events = groupByTx(allEventsQuery.all());
        const troves = groupByTx(allTrovesQuery.all());
        return [...events.keys()].map(hash => [hash, { events: events.get(hash), troves: troves.get(hash) || [] }]);
    }
};
