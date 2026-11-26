// The phone page's data (public/m.html): one compact file with what its four tabs show at first, built from the same exports as the
// desktop page (redemptions, trove snapshot, batch managers), so both show the same figures. The troves, their operations and each
// redemption's detail are loaded by the phone page from the desktop's files (troves.json, troveops.json, tx/<hash>.json) when needed.
// Rules as on the desktop: volume facts include every redemption (an exploit's are named), profit figures and averages leave the
// exploit's redemptions out; discount and oracle gap are BOLD-weighted over redemptions with reliable prices.
const fs = require('fs');
const path = require('path');

const DAY = 864e5;
const SOURCES = ['curve', 'uni_v3', 'uni_v4', 'aero', 'other', 'held'];
const POOLS = ['curve', 'uni_v3', 'uni_v4', 'aero'];

// The transactions of the incidents named on the page (public/incidents.json), e.g. the K3 Capital exploit
function incidentTxs() {
    try {
        const { incidents } = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'incidents.json'), 'utf8'));
        return new Set(incidents.flatMap(i => i.txs || []).map(t => t.toLowerCase()));
    } catch {
        return new Set();
    }
}

const R = (v, d = 2) => v == null ? null : +v.toFixed(d);
const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
// Monday 00:00 UTC of a time (ms)
const monday = ms => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY; };

// What the redemption sheet shows at once; its troves and per-branch figures come from tx/<hash>.json, loaded on tap
function lite(r, inc) {
    const src = {}, pools = {};
    for (const k of SOURCES) if (r[`bold_src_${k}`]) src[k] = R(r[`bold_src_${k}`]);
    for (const k of POOLS) if (r[`price_${k}`] != null) pools[k] = R(r[`price_${k}`], 5);
    return { tx: r.tx_hash, ts: r.timestamp, block: r.block, bold: R(r.amount), branches: r.branches, sender: r.sender, to: r.to_address,
        via: r.via_contract, price: R(r.market_price, 5), spread: R(r.spread, 4), gap: R(r.oracle_gap, 4), feePct: R(r.fee_pct, 4), feeUsd: R(r.fee_usd),
        gapUsd: R(r.gap_x_usd), gross: R(r.gross_profit_usd), gas: R(r.gas_fee_usd), tip: R(r.builder_tip_usd), prioEth: R(r.priority_fee_eth, 6),
        cbEth: R(r.coinbase_tip_eth, 6), net: R(r.net_profit_usd), margin: R(r.net_margin, 4), status: r.actual_status ?? null, flash: r.flash_venue ?? null,
        src, pools, exploit: inc.has(r.tx_hash.toLowerCase()) ? 1 : 0 };
}

// One period of the Redemptions tab (24 hours to 180 days before the end)
function period(reds, end, ms, inc) {
    const all = reds.filter(r => r.timestamp > end - ms), rs = all.filter(r => !inc.has(r.tx_hash.toLowerCase()));
    const rel = rs.filter(r => r.ref_reliable);
    const wavg = k => { const xs = rel.filter(r => r[k] != null); if (!xs.length) return null; return sum(xs, r => r[k] * r.amount) / sum(xs, r => r.amount); };
    const priced = rs.filter(r => r.net_profit_usd != null && r.market_price != null);
    const cost = sum(priced, r => r.amount * r.market_price);
    // the edge and cost parts summed over the redemptions at normal on-chain prices, as the desktop's breakdown: oracle gap,
    // on-chain vs exchange price, BOLD discount (premium when negative), redemption fee, builder tips, gas
    const rest = r => r.gross_profit_usd + r.fee_usd - r.amount * (1 - r.market_price);
    const normal = priced.filter(r => r.ref_reliable);
    const parts = { gap: sum(normal, r => r.gap_x_usd != null ? r.gap_x_usd : rest(r)), trade: sum(normal, r => r.gap_x_usd == null ? 0 : rest(r) - r.gap_x_usd),
        discount: sum(normal, r => r.amount * (1 - r.market_price)), fee: -sum(normal, r => r.fee_usd), tips: -sum(normal, r => r.builder_tip_usd), gas: -sum(normal, r => r.gas_fee_usd) };
    const src = {};
    for (const k of SOURCES) { const v = sum(rs, r => r[`bold_src_${k}`]); if (v) src[k] = Math.round(v); }
    const flash = new Map();
    for (const r of rs) for (const v of (r.flash_venue || 'None').split(',')) flash.set(v, (flash.get(v) || 0) + 1);
    const by = new Map();
    for (const r of rs) {
        if (!by.has(r.sender)) by.set(r.sender, { addr: r.sender, txs: 0, bold: 0, net: 0 });
        const x = by.get(r.sender); x.txs++; x.bold += r.amount; x.net += r.net_profit_usd || 0;
    }
    const bold = sum(rs, r => r.amount);
    return {
        bold: Math.round(sum(all, r => r.amount)), txs: all.length, exploit: Math.round(sum(all.filter(r => inc.has(r.tx_hash.toLowerCase())), r => r.amount)),
        redeemers: new Set(all.map(r => r.sender)).size, metricTxs: rs.length, net: Math.round(sum(priced, r => r.net_profit_usd)),
        gross: Math.round(sum(priced, r => r.gross_profit_usd)), gas: Math.round(sum(priced, r => r.gas_fee_usd)), tips: Math.round(sum(priced, r => r.builder_tip_usd)),
        discount: R(wavg('spread'), 4), gap: R(wavg('oracle_gap'), 4), fee: rs.length ? R(sum(rs, r => r.fee_usd) * 100 / bold, 4) : null,
        margin: cost ? R(sum(priced, r => r.net_profit_usd) * 100 / cost, 4) : null,
        parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])), partsTxs: normal.length, pricedTxs: priced.length,
        src, srcTotal: Math.round(bold), flash: [...flash].sort((a, b) => b[1] - a[1]).slice(0, 5),
        top: [...by.values()].sort((a, b) => b.net - a.net).slice(0, 5).map(t => ({ ...t, bold: Math.round(t.bold), net: Math.round(t.net) }))
    };
}

// A batch manager as the Batch Manager Monitor's opened row: rate steps and redemption hits over 90 days, changes over 30, the score
function managerDetail(b, e) {
    const ch30 = b.changes.filter(c => c[0] > e - 30 * 86400);
    let area = 0;
    b.steps.forEach((st, i) => { area += st[2] * ((i + 1 < b.steps.length ? b.steps[i + 1][0] : e) - st[0]); });
    const span = b.steps.length ? e - b.steps[0][0] : 0;
    return { op: b.operator, st: b.strategy, br: b.branch, addr: b.manager, rate: b.rate, fee: b.fee, debt: b.debt, troves: b.troves, registered: b.registered, score: b.score,
        d30: { changes: ch30.length, early: sum(ch30, c => c[3]), upfront: Math.round(sum(ch30, c => c[4])), leaps: b.leaps.filter(l => l[0] > e - 30 * 86400).length },
        d90: { hits: b.hits.length, redeemed: Math.round(sum(b.hits, h => h[1])), exploit: Math.round(sum(b.hits.filter(h => h[2]), h => h[1])), avgDebt: span ? Math.round(area / span) : 0 },
        steps: b.steps.map(st => [st[0], st[1]]), hits: b.hits.map(h => [h[0], h[1]]) };
}

// Redemption conditions, as the desktop home page computes them (index.html, lpConditions): BOLD redeemed in the last 24 hours
// against every 24-hour stretch with redemptions in the last 180 days, hour by hour (Quiet: none; Low: under the median; Normal: up
// to the 90th percentile; High: above it), the bursts (redemptions more than 2 hours apart start a new one), BOLD redeemed per hour
// over the last 7 days, and how many redemptions of the last 24 hours had distorted on-chain prices. Every redemption counts,
// exploits included
function conditions(reds, asOf) {
    const H = 3600e3, hours = 180 * 24, end = Math.floor(asOf / H) * H + H, start = end - hours * H;
    const hourly = new Float64Array(hours);
    for (const r of reds) if (r.timestamp >= start && r.timestamp < end) hourly[Math.floor((r.timestamp - start) / H)] += r.amount;
    const sums = [];
    for (let i = 0, run = 0; i < hours; i++) { run += hourly[i] - (i >= 24 ? hourly[i - 24] : 0); if (i >= 23) sums.push(run); }
    const active = sums.filter(v => v > 0).sort((a, b) => a - b);
    const q = f => active.length ? active[Math.floor(f * (active.length - 1))] : 0, q50 = q(0.5), q90 = q(0.9);
    const last = reds.filter(r => r.timestamp > asOf - 24 * H && r.timestamp <= asOf).sort((a, b) => a.timestamp - b.timestamp);
    const v24 = sum(last, r => r.amount);
    return { asOf, v24: R(v24), txs: last.length, bursts: last.length ? 1 + last.filter((r, i) => i && r.timestamp - last[i - 1].timestamp > 2 * H).length : 0,
        level: !v24 ? 0 : v24 < q50 ? 1 : v24 < q90 ? 2 : 3, q50: R(q50), q90: R(q90),
        strip: Array.from(hourly.slice(hours - 168), v => Math.round(v)), distorted: last.filter(r => r.ref_distorted).length };
}

// reds: redemption rows (queries.redemptions); troves: the trove snapshot with its weeks ({ typical, busiest }); bm: batch_managers.json;
// status: { lastSyncedBlock, generatedAt }. Null until the trove snapshot and the batch managers' history exist.
function mobileData({ reds, troves, bm, status }) {
    if (!troves || !troves.weeks || !bm) return null;
    const inc = incidentTxs();
    const end = status.generatedAt || Math.max(...reds.map(r => r.timestamp));
    const window = ms => { const rs = reds.filter(r => r.timestamp > end - ms);
        return { bold: Math.round(sum(rs, r => r.amount)), txs: rs.length, exploit: Math.round(sum(rs.filter(r => inc.has(r.tx_hash.toLowerCase())), r => r.amount)) }; };
    // BOLD redeemed per hour (the last 24), per UTC day (the last 180) and per week from Monday 00:00 UTC (the last 26), each with the
    // exploit's part, for the Redemptions tab's chart at the period chosen; a stretch without redemptions counts as 0
    const series = (startOf, step, count) => {
        const last = startOf(end), out = new Map();
        for (let i = count - 1; i >= 0; i--) out.set(last - i * step, [0, 0]);
        for (const r of reds) { const x = out.get(startOf(r.timestamp)); if (x) { x[0] += r.amount; if (inc.has(r.tx_hash.toLowerCase())) x[1] += r.amount; } }
        return [...out].map(([k, [a, b]]) => [k, Math.round(a), Math.round(b)]);
    };
    const H = 3600e3;
    const latest = [...reds].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);

    // Branches now: share of each redemption (debt not covered by the pool, over all branches'), average rate, pool yield, redeemed
    const br = {};
    // collateral ratio of the branch (collateral at the oracle price over debt, as the desktop's Troves tab) and Liquity's thresholds,
    // in %: minimum per trove (MCR), critical for the branch (CCR: operations that lower it are restricted), shutdown (SCR)
    for (const b of troves.branches) br[b.name] = { debt: Math.round(b.debt), sp: Math.round(b.spDeposits), tcr: b.debt ? R(b.coll * b.oraclePrice / b.debt * 100, 2) : null,
        mcr: R(b.mcr * 100, 2), ccr: R(b.ccr * 100, 2), scr: R(b.scr * 100, 2) };
    const unb = Object.fromEntries(Object.entries(br).map(([k, v]) => [k, Math.max(v.debt - v.sp, 0)]));
    const tu = Object.values(unb).reduce((a, v) => a + v, 0), td = Object.values(br).reduce((a, v) => a + v.debt, 0);
    for (const [k, v] of Object.entries(br)) {
        v.share = R((tu ? unb[k] / tu : v.debt / td) * 100, 1);
        const ps = bm.branches[k].samples, last = ps[ps.length - 1];
        v.avgRate = last[3];
        // pool yield, last 30 days, as on the desktop card: BOLD minted to the pool and the change in what is not yet minted,
        // over the time-weighted deposits
        const frm = bm.end - 30 * 86400;
        let i0 = 0; ps.forEach((p, i) => { if (p[0] <= frm) i0 = i; });
        const paid = ps.slice(i0 + 1).reduce((a, p) => a + p[6], 0) + last[5] - ps[i0][5];
        let area = 0; for (let i = i0; i < ps.length - 1; i++) area += ps[i][2] * (ps[i + 1][0] - ps[i][0]);
        const span = last[0] - ps[i0][0];
        v.yield30 = span && area ? R(paid / (area / span) / (span / (365 * 86400)) * 100, 2) : null;
        v.yieldNow = last[2] ? R(0.75 * last[4] / last[2] * 100, 2) : null;
        v.redeemed30 = Math.round(sum(bm.branches[k].redeemed.filter(x => x[0] > bm.end - 30 * 86400), x => x[1]));
    }
    // Batch managers holding debt; "busy" when they made 5 early changes or 4 raises above another batch in 7 days
    const mgr = bm.batches.filter(b => b.debt >= 1).map(b => {
        const d7 = b.changes.filter(c => c[0] > bm.end - 7 * 86400), l7 = b.leaps.filter(l => l[0] > bm.end - 7 * 86400);
        return { op: b.operator, st: b.strategy, br: b.branch, addr: b.manager, rate: b.rate, debt: b.debt, troves: b.troves, score: b.score ? b.score.total : null,
            busy: sum(d7, c => c[3]) >= 5 || l7.length >= 4, changes30: b.changes.filter(c => c[0] > bm.end - 30 * 86400).length };
    }).sort((a, b) => b.debt - a.debt);
    // Branch trends: every third 2-hour sample (6 hours) and the latest, [time, pool / debt in %, average rate, debt]; the samples are
    // read at the same blocks on every branch, so the share of each redemption can be computed per point
    const trends = Object.fromEntries(Object.entries(bm.branches).map(([k, b]) => [k, b.samples.filter((p, i) => i % 3 === 0 || i === b.samples.length - 1)
        .map(p => [p[0], p[1] ? R(p[2] / p[1] * 100, 2) : null, p[3], p[1]])]));

    return {
        updated: end, block: status.lastSyncedBlock ?? null,
        market: { boldUsd: troves.boldUsd ?? null, ethUsd: troves.ethUsd ?? null, redemptionRate: troves.redemptionRate ?? null },
        activity: { d1: window(DAY), d7: window(7 * DAY), d30: window(30 * DAY), typicalWeek: Math.round(troves.weeks.typical), busiestWeek: Math.round(troves.weeks.busiest),
            lastTs: reds.length ? Math.max(...reds.map(r => r.timestamp)) : null,
            activeTroves: Object.fromEntries(troves.branches.map(b => [b.name, troves.troves.filter(t => t.branch === b.index && t.status === 1).length])) },
        conditions: conditions(reds, end),
        weeks: series(monday, 7 * DAY, 26), days: series(ts => Math.floor(ts / DAY) * DAY, DAY, 180), hours: series(ts => Math.floor(ts / H) * H, H, 24),
        latest: latest.map(r => lite(r, inc)),
        names: Object.fromEntries(bm.batches.map(b => [b.manager, [b.operator, b.strategy]])),
        branches: br, managers: mgr,
        periods: Object.fromEntries([['d1', 1], ['d7', 7], ['d30', 30], ['d90', 90], ['d180', 180]].map(([k, d]) => [k, period(reds, end, d * DAY, inc)])),
        monitor: { end: bm.end, systemNow: null, managers: bm.batches.filter(b => b.debt >= 1).sort((a, b) => b.debt - a.debt).map(b => managerDetail(b, bm.end)) },
        trends
    };
}

module.exports = { mobileData };
