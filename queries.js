const db = require('./db');

// A sender is flagged as a bot if it redeems through a contract or at least this often
const BOT_MIN_REDEMPTIONS = 3;

const redemptionsQuery = db.prepare(`
    WITH counts AS (SELECT sender, COUNT(*) AS n FROM redemptions GROUP BY sender)
    SELECT r.*, (r.via_contract OR c.n >= ${BOT_MIN_REDEMPTIONS}) AS is_bot
    FROM redemptions r JOIN counts c USING (sender)
    ORDER BY r.block DESC, r.tx_hash
    LIMIT ?`);

const botsQuery = db.prepare(`
    SELECT sender AS address,
           COUNT(*) AS frequency,
           SUM(amount) AS total_bold,
           AVG(net_edge) AS avg_edge,
           SUM(net_profit_usd) AS net_profit_usd,
           MAX(via_contract) AS via_contract,
           MAX(timestamp) AS last_active
    FROM redemptions
    GROUP BY sender
    HAVING MAX(via_contract) = 1 OR COUNT(*) >= ${BOT_MIN_REDEMPTIONS}
    ORDER BY net_profit_usd DESC, frequency DESC`);

const statsQuery = db.prepare(`
    SELECT COUNT(*) AS tx_count,
           COALESCE(SUM(amount), 0) AS total_bold,
           COUNT(DISTINCT sender) AS senders,
           SUM(spread * amount) / SUM(CASE WHEN spread IS NOT NULL THEN amount END) AS avg_spread,
           SUM(oracle_gap * amount) / SUM(CASE WHEN oracle_gap IS NOT NULL THEN amount END) AS avg_oracle_gap,
           SUM(net_edge * amount) / SUM(CASE WHEN net_edge IS NOT NULL THEN amount END) AS avg_edge,
           SUM(fee_usd) * 100 / SUM(amount) AS avg_fee,
           SUM(gross_profit_usd) AS gross_profit_usd,
           SUM(net_profit_usd) AS net_profit_usd,
           SUM(gas_fee_usd) AS gas_fee_usd,
           SUM(builder_tip_usd) AS builder_tip_usd,
           SUM(net_profit_usd) * 100 / SUM(CASE WHEN net_profit_usd IS NOT NULL THEN amount * market_price END) AS avg_margin,
           MAX(timestamp) AS last_redemption
    FROM redemptions`);

// Per-transaction detail: the branch-level Redemption events and the troves they touched
const txEventsQuery = db.prepare('SELECT * FROM redemption_events WHERE tx_hash = ? ORDER BY log_index');
const txTrovesQuery = db.prepare('SELECT * FROM redemption_troves WHERE tx_hash = ? ORDER BY log_index');
const allEventsQuery = db.prepare('SELECT * FROM redemption_events ORDER BY tx_hash, log_index');
const allTrovesQuery = db.prepare('SELECT * FROM redemption_troves ORDER BY tx_hash, log_index');

function groupByTx(rows) {
    const map = new Map();
    for (const r of rows) {
        if (!map.has(r.tx_hash)) map.set(r.tx_hash, []);
        map.get(r.tx_hash).push(r);
    }
    return map;
}

module.exports = {
    redemptions: (limit = 5000) => redemptionsQuery.all(limit),
    bots: () => botsQuery.all(),
    stats: () => statsQuery.get(),
    txDetail: hash => ({ events: txEventsQuery.all(hash), troves: txTrovesQuery.all(hash) }),
    // Every transaction's detail at once, for the static export
    allTxDetails: () => {
        const events = groupByTx(allEventsQuery.all());
        const troves = groupByTx(allTrovesQuery.all());
        return [...events.keys()].map(hash => [hash, { events: events.get(hash), troves: troves.get(hash) || [] }]);
    }
};
