// BOLD bought from the four BOLD/USDC pools the dashboard tracks (Curve, Uniswap v3, Uniswap v4, Aero), for the Redemptions tab's pool
// volume cards: how much of the BOLD bought from each pool went into redemptions. Read from the pools' events through Etherscan's log
// API: every swap, and on Curve also the liquidity events, because adding USDC and taking out BOLD alone in one transaction is a purchase
// without a swap event (some redeemers buy BOLD that way). Each event is stored once (pool_events; swaps selling BOLD into a pool are
// not needed and not stored); the export sums them per UTC day.
// Once caught up, a sync costs one request per event stream (six); the first run reads the history since the V2 launch (about 50
// requests). Independent of the redemption sync: export.js and index.js call syncPoolVolume() after it, and a failure here leaves the
// other data untouched. BOLD is token 0 in all four pools.
const { ethers } = require('ethers');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
// The pool addresses as the redemption sync reads them: from .env, else worker.js's defaults (GitHub Actions has no .env)
const { env } = require('./worker');

const START_BLOCK = Number(env('START_BLOCK'));                           // CollateralRegistry deployment block, as in worker.js
const PAGE = 1000;                                                         // Etherscan's maximum per log request
const FULL = 900;                                                          // a full page sometimes comes back with 999 records
const SWAP_V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const abi = ethers.AbiCoder.defaultAbiCoder();

// The event streams: a pool's address and event, decoded into BOLD out of the pool (bought) and BOLD into it. Uniswap v3 and Aero
// (Slipstream) report amounts from the pool's side (positive = into the pool), Uniswap v4 from the swapper's side (positive = to the
// swapper); Curve's TokenExchange names the coin bought. Curve's AddLiquidity and RemoveLiquidityOne are kept for the round trips.
function streams() {
    const curve = env('CURVE_POOL_ADDRESS_BOLD_USDC').toLowerCase();
    const v3 = data => { const [a0] = abi.decode(['int256'], ethers.dataSlice(data, 0, 32)); return a0 < 0n ? { boldOut: -a0 } : { boldIn: a0 }; };
    return [
        { key: 'curve:swap', pool: 'curve', kind: 'swap', address: curve,
            topic0: ethers.id('TokenExchange(address,int128,uint256,int128,uint256)'),
            decode: data => { const [soldId, sold, boughtId, bought] = abi.decode(['int128', 'uint256', 'int128', 'uint256'], data);
                return Number(boughtId) === 0 ? { boldOut: bought } : Number(soldId) === 0 ? { boldIn: sold } : {}; } },
        { key: 'curve:add', pool: 'curve', kind: 'add', address: curve,
            topic0: ethers.id('AddLiquidity(address,uint256[],uint256[],uint256,uint256)'),
            decode: data => ({ boldIn: abi.decode(['uint256[]'], data)[0][0] }) },
        { key: 'curve:remove', pool: 'curve', kind: 'remove', address: curve,
            topic0: ethers.id('RemoveLiquidityOne(address,int128,uint256,uint256,uint256)'),
            decode: data => { const [id, , coin] = abi.decode(['int128', 'uint256', 'uint256'], ethers.dataSlice(data, 0, 96)); return Number(id) === 0 ? { boldOut: coin } : {}; } },
        { key: 'uni_v3:swap', pool: 'uni_v3', kind: 'swap', address: env('UNISWAP_V3_POOL_ADDRESS_BOLD_USDC').toLowerCase(), topic0: SWAP_V3, decode: v3 },
        { key: 'uni_v4:swap', pool: 'uni_v4', kind: 'swap', address: env('UNISWAP_V4_POOL_MANAGER').toLowerCase(),
            topic0: ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'), topic1: env('UNISWAP_V4_POOL_ID_BOLD_USDC').toLowerCase(),
            decode: data => { const [a0] = abi.decode(['int128'], ethers.dataSlice(data, 0, 32)); return a0 > 0n ? { boldOut: a0 } : { boldIn: -a0 }; } },
        { key: 'aero:swap', pool: 'aero', kind: 'swap', address: '0x82ccbb91c69e75037bb972f28cc01e704e325362', topic0: SWAP_V3, decode: v3 }
    ];
}

const getState = db.prepare('SELECT value FROM sync_state WHERE key = ?');
const setState = db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)');
const insertEvent = db.prepare(`INSERT OR IGNORE INTO pool_events (pool, tx_hash, log_index, block, timestamp, kind, bold_out, bold_in)
    VALUES (@pool, @tx_hash, @log_index, @block, @timestamp, @kind, @bold_out, @bold_in)`);
// Stores a page of events and the block its stream is complete to; returns the number of new rows
const savePage = db.transaction((rows, key, block) => { const n = rows.reduce((a, r) => a + insertEvent.run(r).changes, 0); setState.run(key, String(block)); return n; });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One Etherscan log request; "No records found" is an empty result, rate limits and network errors are retried
async function getLogs(s, fromBlock, toBlock) {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${s.address}&topic0=${s.topic0}`
        + (s.topic1 ? `&topic0_1_opr=and&topic1=${s.topic1}` : '')
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

const bold = v => v == null ? 0 : Number(v) / 1e18;
function decode(s, log) {
    const x = s.decode(log.data);
    return { pool: s.pool, tx_hash: log.transactionHash.toLowerCase(), log_index: parseInt(log.logIndex, 16), block: parseInt(log.blockNumber, 16),
        timestamp: parseInt(log.timeStamp, 16) * 1000, kind: s.kind, bold_out: bold(x.boldOut), bold_in: bold(x.boldIn) };
}

// Reads every stream up to the block the redemptions are synced to, so both cover the same blocks
async function syncPoolVolume() {
    if (!process.env.ETHERSCAN_API_KEY) return { skipped: 'ETHERSCAN_API_KEY is not set' };
    const to = Number(getState.get('last_block')?.value);
    if (!to) return { skipped: 'redemptions not synced yet' };
    let requests = 0, added = 0;
    for (const s of streams()) {
        const key = `pool_volume_block:${s.key}`;
        let from = Number(getState.get(key)?.value ?? START_BLOCK - 1) + 1;
        while (from <= to) {
            const logs = await getLogs(s, from, to);
            requests++;
            // A full page may stop inside a block: the next request starts again at that block (events already stored are ignored)
            const full = logs.length >= FULL, last = full ? parseInt(logs[logs.length - 1].blockNumber, 16) : to;
            if (full && last <= from) throw new Error(`more than ${FULL} ${s.key} events in block ${from}`);
            added += savePage(logs.map(l => decode(s, l)).filter(r => r.kind !== 'swap' || r.bold_out > 0), key, full ? last - 1 : to);
            from = full ? last : to + 1;
            await sleep(250);                                              // Etherscan's free tier allows a few requests per second
        }
    }
    return { requests, added, toBlock: to };
}

// BOLD bought per pool and UTC day: the BOLD out of every swap, and on Curve the round trips, a transaction that added liquidity and
// took out BOLD alone (its BOLD out minus any BOLD it added); a withdrawal without an add in the same transaction is not a purchase.
// purchases: the swaps and round trips that bought BOLD
const swapDays = db.prepare(`SELECT pool, date(timestamp / 1000, 'unixepoch') AS day, SUM(bold_out) AS bold_out, SUM(bold_out > 0) AS purchases
    FROM pool_events WHERE kind = 'swap' GROUP BY pool, day`);
const roundTripDays = db.prepare(`SELECT day, SUM(bought) AS bold_out, COUNT(*) AS purchases FROM (
        SELECT date(MIN(timestamp) / 1000, 'unixepoch') AS day,
               SUM(CASE WHEN kind = 'remove' THEN bold_out ELSE 0 END) - SUM(CASE WHEN kind = 'add' THEN bold_in ELSE 0 END) AS bought
        FROM pool_events WHERE pool = 'curve' AND kind IN ('add', 'remove') GROUP BY tx_hash
        HAVING SUM(kind = 'add') > 0 AND SUM(kind = 'remove') > 0)
    WHERE bought > 0 GROUP BY day`);
const streamBlocks = db.prepare(`SELECT MIN(CAST(value AS INTEGER)) AS block, COUNT(*) AS n FROM sync_state WHERE key LIKE 'pool_volume_block:%'`);

// { toBlock, daily: { pool: { 'YYYY-MM-DD': { boldOut, purchases } } } }, or null before the first sync; toBlock: the block every
// stream is complete to
function poolVolumeExport() {
    const state = streamBlocks.get();
    if (state.n < streams().length) return null;
    const daily = {}, round = v => Math.round(v * 100) / 100;
    for (const r of swapDays.all()) (daily[r.pool] ??= {})[r.day] = { boldOut: round(r.bold_out), purchases: r.purchases };
    for (const r of roundTripDays.all()) {
        const d = ((daily.curve ??= {})[r.day] ??= { boldOut: 0, purchases: 0 });
        d.boldOut = round(d.boldOut + r.bold_out); d.purchases += r.purchases;
    }
    return { toBlock: state.block, daily };
}

module.exports = { syncPoolVolume, poolVolumeExport };

if (require.main === module) {
    syncPoolVolume()
        .then(r => console.log(`Pool volume: ${JSON.stringify(r)}`))
        .catch(e => { console.error(e.message); process.exit(1); });
}
