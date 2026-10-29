// Every trove operation other than redemptions, for the Troves tab's borrowing record: opening, borrowing and repaying,
// collateral added and withdrawn, closing, rate and batch changes and liquidations, read from each branch's TroveManager
// (TroveOperation events) through Etherscan's log API. Once caught up, a sync costs one request per branch; the first run
// reads the history since the V2 launch (a few dozen requests). Redemptions are already in redemption_troves.
// Independent of the redemption sync (worker.js): export.js and index.js call syncTroveOps() after the trove snapshot,
// and a failure here leaves the other data untouched.
const { ethers } = require('ethers');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
const { latestTroveSnapshot } = require('./troves');

const START_BLOCK = Number(process.env.START_BLOCK || 22516069);         // CollateralRegistry deployment block, as in worker.js
const TOPIC = ethers.id('TroveOperation(uint256,uint8,uint256,uint256,uint256,int256,uint256,int256)');
// Liquity's Operation enum (TroveManager); 6 is redeemCollateral, recorded with the redemptions
const OPERATIONS = ['openTrove', 'closeTrove', 'adjustTrove', 'adjustTroveInterestRate', 'applyPendingDebt', 'liquidate',
    'redeemCollateral', 'openTroveAndJoinBatch', 'setInterestBatchManager', 'removeFromBatch'];
const PAGE = 1000;                                                         // Etherscan's maximum per log request
const FULL = 900;                                                          // a full page sometimes comes back with 999 records
const DAY = 864e5;

const getState = db.prepare('SELECT value FROM sync_state WHERE key = ?');
const setState = db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)');
const insertOp = db.prepare(`INSERT OR IGNORE INTO trove_ops (tx_hash, log_index, block, timestamp, branch, trove_id, operation, interest_rate,
    debt_change, upfront_fee, coll_change) VALUES (@tx_hash, @log_index, @block, @timestamp, @branch, @trove_id, @operation, @interest_rate,
    @debt_change, @upfront_fee, @coll_change)`);
// Stores a page of operations and the block they are complete to; returns the number of new rows
const savePage = db.transaction((rows, key, block) => { const n = rows.reduce((a, r) => a + insertOp.run(r).changes, 0); setState.run(key, String(block)); return n; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number(ethers.formatEther(v));

// One Etherscan log request; "No records found" is an empty result, rate limits and network errors are retried
async function getLogs(address, fromBlock, toBlock) {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${address}&topic0=${TOPIC}`
        + `&fromBlock=${fromBlock}&toBlock=${toBlock}&page=1&offset=${PAGE}&apikey=${process.env.ETHERSCAN_API_KEY}`;
    for (let i = 0; ; i++) {
        try {
            const r = await fetch(url).then(x => x.json());
            if (Array.isArray(r.result)) return r.result;
            if (/no records/i.test(r.message || '')) return [];
            throw new Error(`Etherscan: ${r.result || r.message}`);
        } catch (e) {
            if (i >= 5) throw e;
            await sleep(1000 * 2 ** i);
        }
    }
}

function decode(log, branch) {
    const [op, rate, , fee, debtChange, , collChange] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint8', 'uint256', 'uint256', 'uint256', 'int256', 'uint256', 'int256'], log.data);
    return {
        tx_hash: log.transactionHash.toLowerCase(), log_index: parseInt(log.logIndex, 16), block: parseInt(log.blockNumber, 16),
        timestamp: parseInt(log.timeStamp, 16) * 1000, branch, trove_id: log.topics[1].toLowerCase(), operation: OPERATIONS[Number(op)] ?? `op${op}`,
        interest_rate: num(rate) * 100, debt_change: num(debtChange), upfront_fee: num(fee), coll_change: num(collChange)
    };
}

// Reads the operations of every branch up to the block the redemptions are synced to, so both cover the same blocks
async function syncTroveOps() {
    if (!process.env.ETHERSCAN_API_KEY) return { skipped: 'ETHERSCAN_API_KEY is not set' };
    const snapshot = latestTroveSnapshot();
    if (!snapshot) return { skipped: 'no trove snapshot yet' };
    const to = Number(getState.get('last_block')?.value);
    if (!to) return { skipped: 'redemptions not synced yet' };
    let requests = 0, added = 0;
    for (const b of snapshot.branches) {
        const key = `trove_ops_block:${b.name}`;
        let from = Number(getState.get(key)?.value ?? START_BLOCK - 1) + 1;
        while (from <= to) {
            const logs = await getLogs(b.troveManager, from, to);
            requests++;
            const rows = logs.map(l => decode(l, b.name)).filter(r => r.operation !== 'redeemCollateral');
            // A full page may stop inside a block: the next request starts again at that block (rows already stored are ignored)
            const full = logs.length >= FULL, last = full ? parseInt(logs[logs.length - 1].blockNumber, 16) : to;
            if (full && last <= from) throw new Error(`more than ${FULL} trove operations in block ${from} on ${b.name}`);
            added += savePage(rows, key, full ? last - 1 : to);
            from = full ? last : to + 1;
            await sleep(250);                                              // Etherscan's free tier allows a few requests per second
        }
    }
    return { requests, added, toBlock: to };
}

// Monday 00:00 UTC of the week of a timestamp, as the page's weekly charts
function mondayOf(ts) {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
}

const opsQuery = db.prepare(`SELECT timestamp, branch, trove_id, operation, debt_change, coll_change FROM trove_ops
    WHERE operation NOT IN ('liquidate', 'redeemCollateral') ORDER BY timestamp`);
const redeemedSince = db.prepare(`SELECT t.branch, t.trove_id, SUM(t.debt_redeemed) AS debt FROM redemption_troves t JOIN redemptions r USING (tx_hash)
    WHERE r.timestamp >= ? AND r.timestamp <= ? GROUP BY t.branch, t.trove_id`);

// Per trove of the latest snapshot: BOLD borrowed and repaid and collateral added and withdrawn per week, and the last 30 days
// (BOLD redeemed, borrowed and collateral added), keyed like the page's troves ("branch index:trove ID"). Liquidations are left out.
function troveOpsExport() {
    const snapshot = latestTroveSnapshot();
    if (!snapshot) return null;
    const index = new Map(snapshot.branches.map(b => [b.name, b.index]));
    const keep = new Set(snapshot.troves.map(t => `${t.branch}:${t.id}`));
    const end = snapshot.ts * 1000, since = end - 30 * DAY;
    const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
    const troves = {};
    const entry = key => troves[key] ??= { w: new Map(), b30: 0, c30: 0, r30: 0, lastBorrow: null };
    for (const o of opsQuery.iterate()) {
        const key = `${index.get(o.branch)}:${o.trove_id}`;
        if (!keep.has(key) || o.timestamp > end) continue;
        const e = entry(key), w = mondayOf(o.timestamp);
        const week = e.w.get(w) ?? [0, 0, 0, 0];
        if (o.debt_change > 0) { week[0] += o.debt_change; e.lastBorrow = o.timestamp; if (o.timestamp >= since) e.b30 += o.debt_change; }
        else week[1] -= o.debt_change;
        if (o.coll_change > 0) { week[2] += o.coll_change; if (o.timestamp >= since) e.c30 += o.coll_change; }
        else week[3] -= o.coll_change;
        e.w.set(w, week);
    }
    for (const r of redeemedSince.all(since, end)) {
        const key = `${index.get(r.branch)}:${r.trove_id.toLowerCase()}`;
        if (keep.has(key)) entry(key).r30 = r.debt;
    }
    for (const [key, e] of Object.entries(troves)) {
        troves[key] = {
            // [Monday 00:00 UTC (ms), BOLD borrowed, BOLD repaid, collateral added, collateral withdrawn]
            w: [...e.w].filter(([, v]) => v.some(x => x > 0)).map(([w, [b, r, ci, co]]) => [w, round(b, 0), round(r, 0), round(ci, 4), round(co, 4)]),
            b30: round(e.b30, 0), r30: round(e.r30, 0), c30: round(e.c30, 4), lastBorrow: e.lastBorrow
        };
    }
    return { ts: snapshot.ts, troves };
}

module.exports = { syncTroveOps, troveOpsExport };

if (require.main === module) {
    syncTroveOps()
        .then(r => console.log(`Trove operations: ${JSON.stringify(r)}`))
        .catch(e => { console.error(e.message); process.exit(1); });
}
