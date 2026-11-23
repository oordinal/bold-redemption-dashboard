// Batch managers and branch trends, for the Troves tab's Batch Manager monitor and Branch trends cards.
//   1. Every BatchUpdated event of the three TroveManagers (Etherscan's log API), stored once in batch_events: a batch's rate,
//      management fee, debt after the event and the upfront fee the event added to its debt. Once caught up, one request per branch.
//   2. Each branch's debt, Stability Pool deposits, average interest rate, interest a year and the pool's yield not yet minted, read at the
//      trove snapshot's block after every sync (one Multicall3 call), stored in branch_samples. The history from BACKFILL_FROM is filled
//      once, every 2 hours, at past blocks. Then the BOLD minted to each Stability Pool (its 75% of interest and upfront fees; BOLD Transfer
//      events from the zero address, Etherscan), each mint added to the first sample at or after its block (sp_minted), from the first
//      sample on, once the history is complete: the pool's realized yield between any two samples, exactly.
//   3. Operator names: Liquity's list of known delegates (re-read once a day, the last good copy kept in sync_state; a copy of
//      22 November 2026 if it was never read), plus OTHER_NAMES for managers that list does not name.
// Independent of the redemption sync (worker.js): export.js and index.js call syncBatchManagers() after the trove snapshot, and a
// failure here leaves the other data untouched. batchManagersExport() builds batch_managers.json.
const { ethers } = require('ethers');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
const { latestTroveSnapshot } = require('./troves');

const START_BLOCK = Number(process.env.START_BLOCK || 22516069);         // CollateralRegistry deployment block, as in worker.js
const TOPIC = ethers.id('BatchUpdated(address,uint8,uint256,uint256,uint256,uint256,uint256,uint256)');
// Liquity V2's BatchOperation enum (ITroveEvents)
const OPERATIONS = ['registerBatchManager', 'lowerBatchManagerFee', 'setBatchManagerAnnualInterestRate', 'applyBatchInterestAndFeePermissionless',
    'joinBatch', 'exitBatch', 'troveChange'];
const SET_RATE = 'setBatchManagerAnnualInterestRate';
const BOLD = '0x6440f144b7e50d6a8439336510312d2f54beb01d';
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ZERO_TOPIC = '0x' + '0'.repeat(64);
const PAGE = 1000;                                                         // Etherscan's maximum per log request
const FULL = 900;                                                          // a full page sometimes comes back with 999 records
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BACKFILL_FROM = Date.UTC(2026, 7, 20) / 1000;                        // branch history before the first live sample: from 20 Aug 2026
const BACKFILL_STEP = 7200;                                                // every 2 hours
const BACKFILL_CONCURRENCY = 4;
const KNOWN_DELEGATES_URL = 'https://api.liquity.org/v2/known-delegates/ethereum.json';

// The figures of the Batch Manager monitor. As in Liquity's BorrowerOperations and TroveManager: a batch's adjustment time is set when it
// registers and at every setBatchManagerAnnualInterestRate, also one that keeps the same rate; an upfront fee is charged when the new rate
// differs from the current one (at full precision) and the adjustment time is less than COOLDOWN ago. A rate change here is such an update
// to a different rate; an update to the same rate restarts the cooldown but is not a change
const COOLDOWN = 7 * 86400;          // Liquity's INTEREST_RATE_ADJ_COOLDOWN
const LEAP_WINDOW = 3 * 3600;        // a raise counts as a raise just above another batch when that batch raised within this time before
const WINDOW = 90 * 86400;           // the score's period, and the history exported
const MIN_SCORED_DEBT = 50000;       // batches with less average debt over the period are not scored
// The score: four parts of 25 points; each keeps 25 points at 0 and falls in a straight line to 0 points at zeroAt
const SCORE = {
    rate: { zeroAt: 3, unit: 'points above the average borrower' },     // average rate minus the average rate of all BOLD borrowers
    fees: { zeroAt: 1.5, unit: '% of average debt' },                    // management and upfront fees over the period
    chasing: { zeroAt: 10, unit: 'per 30 days' },                         // raises just above another batch
    redeemed: { zeroAt: 20, unit: '% of average debt' }                   // BOLD redeemed from its troves (the exploit's redemptions included: those troves were redeemed)
};

// Liquity's list of known delegates on 22 November 2026, used until the list has been read once
const KNOWN_DELEGATES = [
    ['Summerstone', 'Conservative', ['0x0000000000b1b2ea2ecdaed0c7a3c402218e3cb0', '0x00000000006c021d70549b7ee216f7ca8d7b6263', '0x0000000000c9b5c50439608f2b8df9fad5362a08']],
    ['Summerstone', 'Balanced', ['0x00000000001991cee928c561e37725816cbf73ba', '0x000000000017d2a7b863e9ebbe6f9ab7255eb7c5', '0x0000000000704f94ce2fe636dab92677a9745dc3']],
    ['Summerstone', 'Aggressive', ['0x00000000003b24f6895911d5e7ba18d6caa1da2b', '0x000000000036abd8fe2238a541ec72f91ceebefa', '0x0000000000cbed6433d0777552ee00f9c8e40f76']],
    ['Trove Zero', '', ['0xe707784292289be3aa0fb6f9d33d420291f98695']],
    ['Bolder Cash', 'Low Rate', ['0x25bc0272217fb0fd7a2ff0d62cebe1aba15e4d91']],
    ['Bolder Cash', 'Mid Rate', ['0x50bc02c6c7124e6e1b8333b80a0416e504e2d044']],
    ['Bolder Cash', 'High Rate', ['0x75bc02022344159b7ef50a3ff5291dd2bc6918c7']],
    ['Autonomous Rate Manager', '', ['0xe507e4d0763851a6287238aadd243948d18ab60a', '0x8869a6fb59a8df330f90d9fbf46ebfaff6d4bc14', '0x7700b2d305f47ae82e9598bab6d7ccb57299a82b']]
];
// Managers the list does not name: Bolder Cash's first contracts (Etherscan names them BolderCashProxy, same address prefixes as its
// current ones), a self-managed batch (ENS name of the account) and three identical unverified contracts registered on 29 May 2025
const OTHER_NAMES = {
    '0x25bc01fd5a01b1864a7dbaddb05bfed642340da2': ['Bolder Cash', 'Low Rate (v1)'],
    '0x50bc019abdb9951602bc4fe92947d3c15d5e45df': ['Bolder Cash', 'Mid Rate (v1)'],
    '0x75bc01bf1e21ed33915777c131b62bb13b5f2552': ['Bolder Cash', 'High Rate (v1)'],
    '0x1578ed833d986c1188d1a998aa5fecd418bef5da': ['caramila.eth', 'self-managed']
};

const getState = db.prepare('SELECT value FROM sync_state WHERE key = ?');
const setState = db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)');
const insertEvent = db.prepare(`INSERT OR IGNORE INTO batch_events (tx_hash, log_index, block, timestamp, branch, manager, operation, debt,
    interest_rate, interest_rate_raw, management_fee, upfront_fee) VALUES (@tx_hash, @log_index, @block, @timestamp, @branch, @manager, @operation,
    @debt, @interest_rate, @interest_rate_raw, @management_fee, @upfront_fee)`);
const savePage = db.transaction((rows, key, block) => { const n = rows.reduce((a, r) => a + insertEvent.run(r).changes, 0); setState.run(key, String(block)); return n; });
// Development copies made before the interest columns: the samples are read again (the table is not in the published database yet)
if (!db.prepare('PRAGMA table_info(branch_samples)').all().some(c => c.name === 'sp_minted_incident')) {
    db.exec(`DROP TABLE IF EXISTS branch_samples; DROP TABLE IF EXISTS sp_yield;
        DELETE FROM sync_state WHERE key LIKE 'branch_samples%' OR key LIKE 'sp_yield%';`);
    db.exec(require('fs').readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}
const insertSample = db.prepare(`INSERT OR IGNORE INTO branch_samples (branch, block, timestamp, debt, sp_deposits, avg_rate, interest, pending_sp_yield)
    VALUES (@branch, @block, @timestamp, @debt, @sp_deposits, @avg_rate, @interest, @pending_sp_yield)`);
// Mints to a pool, each added to the first sample at or after its block; in an exploit's transaction, the part from the upfront fees paid
// in it (75% of them, trove_ops and batch_events: synced before) also to sp_minted_incident. The position of the last log read (block, log
// index) is saved with them, so a log read twice (a page restarting inside a block) is counted once
const INCIDENT_TXS = new Set(require('./public/incidents.json').incidents.flatMap(i => i.txs));
const txFees = db.prepare(`SELECT (SELECT COALESCE(SUM(upfront_fee), 0) FROM trove_ops WHERE tx_hash = @tx AND branch = @branch)
    + (SELECT COALESCE(SUM(upfront_fee), 0) FROM batch_events WHERE tx_hash = @tx AND branch = @branch) AS fees`);
const SP_YIELD_SPLIT = 0.75;                                               // Liquity's share of interest and upfront fees minted to the pool
const addMint = db.prepare(`UPDATE branch_samples SET sp_minted = sp_minted + ?, sp_minted_incident = sp_minted_incident + ?
    WHERE branch = ? AND block = (SELECT MIN(block) FROM branch_samples WHERE branch = ? AND block >= ?)`);
const saveYield = db.transaction((branch, mints, pos, block, budget) => {
    for (const m of mints) {
        let incident = 0;
        if (INCIDENT_TXS.has(m.tx)) {
            const key = `${branch}:${m.tx}`;
            if (!budget.has(key)) budget.set(key, SP_YIELD_SPLIT * txFees.get({ tx: m.tx, branch }).fees);
            incident = Math.min(m.amount, budget.get(key));
            budget.set(key, budget.get(key) - incident);
        }
        if (addMint.run(m.amount, incident, branch, branch, m.block).changes !== 1) throw new Error(`no ${branch} sample at or after block ${m.block}`);
    }
    if (pos) setState.run(`sp_yield_pos:${branch}`, pos);
    setState.run(`sp_yield_block:${branch}`, String(block));
    return mints.length;
});
const saveSamples = db.transaction(rows => rows.reduce((a, r) => a + insertSample.run(r).changes, 0));
// Live samples (after the filled history) older than 7 days: only the latest of each 2-hour step is kept (the export uses one per 2 hours);
// the BOLD minted to the pool in the samples removed is added to the one kept (the next in its step), so the totals do not change
const pruneMerge = db.prepare(`UPDATE branch_samples AS k SET (sp_minted, sp_minted_incident) = (SELECT k.sp_minted + COALESCE(SUM(s.sp_minted), 0),
        k.sp_minted_incident + COALESCE(SUM(s.sp_minted_incident), 0) FROM branch_samples s
        WHERE s.branch = k.branch AND s.timestamp / ${BACKFILL_STEP * 1000} = k.timestamp / ${BACKFILL_STEP * 1000} AND s.block <> k.block
        AND s.timestamp < @before AND s.timestamp > @after)
    WHERE k.block = (SELECT MAX(s.block) FROM branch_samples s WHERE s.branch = k.branch AND s.timestamp / ${BACKFILL_STEP * 1000} = k.timestamp / ${BACKFILL_STEP * 1000})
        AND EXISTS (SELECT 1 FROM branch_samples s WHERE s.branch = k.branch AND s.timestamp / ${BACKFILL_STEP * 1000} = k.timestamp / ${BACKFILL_STEP * 1000}
        AND s.block <> k.block AND s.timestamp < @before AND s.timestamp > @after)`);
const pruneDelete = db.prepare(`DELETE FROM branch_samples WHERE timestamp < @before AND timestamp > @after AND block NOT IN
    (SELECT MAX(block) FROM branch_samples GROUP BY branch, timestamp / ${BACKFILL_STEP * 1000})`);
const pruneSamples = { run: db.transaction((before, after) => { pruneMerge.run({ before, after }); return pruneDelete.run({ before, after }); }) };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number(v) / 1e18;

// One Etherscan log request; "No records found" is an empty result, rate limits and network errors are retried
async function getLogs(address, fromBlock, toBlock, topics = `&topic0=${TOPIC}`) {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs&address=${address}${topics}`
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

// BatchUpdated(address indexed manager, uint8 operation, uint256 debt, uint256 coll, uint256 annualInterestRate,
//              uint256 annualManagementFee, uint256 totalDebtShares, uint256 debtIncreaseFromUpfrontFee)
function decode(log, branch) {
    const [op, debt, , rate, fee, , upfront] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint8', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'], log.data);
    return {
        tx_hash: log.transactionHash.toLowerCase(), log_index: parseInt(log.logIndex, 16), block: parseInt(log.blockNumber, 16),
        timestamp: parseInt(log.timeStamp, 16) * 1000, branch, manager: '0x' + log.topics[1].slice(26).toLowerCase(),
        operation: OPERATIONS[Number(op)] ?? `op${op}`, debt: num(debt),
        interest_rate: Number(rate) / 1e16, interest_rate_raw: rate.toString(), management_fee: Number(fee) / 1e16, upfront_fee: num(upfront)
    };
}

function makeProvider() {
    const k = (process.env.RPC_URL || process.env.ALCHEMY_API_KEY || '').trim();
    const url = !k ? 'https://ethereum-rpc.publicnode.com' : k.startsWith('http') ? k : `https://eth-mainnet.g.alchemy.com/v2/${k}`;
    const req = new ethers.FetchRequest(url);
    req.timeout = 30000;
    return new ethers.JsonRpcProvider(req, 1, { staticNetwork: true });
}

async function withRetry(fn, attempts = 6) {
    for (let i = 0; ; i++) {
        try { return await fn(); } catch (e) {
            if (i >= attempts - 1) throw e;
            await sleep(500 * 2 ** i * (0.75 + Math.random() / 2));
        }
    }
}

const I = {
    mc: new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
        'function getCurrentBlockTimestamp() view returns (uint256)']),
    tm: new ethers.Interface(['function stabilityPool() view returns (address)', 'function borrowerOperations() view returns (address)',
        'function getEntireBranchDebt() view returns (uint256)']),
    bo: new ethers.Interface(['function activePool() view returns (address)']),
    sp: new ethers.Interface(['function getTotalBoldDeposits() view returns (uint256)']),
    ap: new ethers.Interface(['function aggWeightedDebtSum() view returns (uint256)', 'function aggRecordedDebt() view returns (uint256)',
        'function calcPendingSPYield() view returns (uint256)'])
};

async function multicall(provider, calls, blockTag) {
    const data = I.mc.encodeFunctionData('aggregate3', [calls.map(([target, iface, fn]) => ({ target, allowFailure: false, callData: iface.encodeFunctionData(fn) }))]);
    const raw = await withRetry(() => provider.call({ to: MULTICALL3, data, blockTag }));
    return I.mc.decodeFunctionResult('aggregate3', raw)[0].map((r, i) => calls[i][1].decodeFunctionResult(calls[i][2], r.returnData)[0]);
}

// Each branch's Stability Pool and ActivePool (fixed contracts, read once per run)
async function branchContracts(provider, branches) {
    const a = await multicall(provider, branches.flatMap(b => [[b.troveManager, I.tm, 'stabilityPool'], [b.troveManager, I.tm, 'borrowerOperations']]), 'latest');
    const ap = await multicall(provider, branches.map((b, i) => [a[2 * i + 1], I.bo, 'activePool']), 'latest');
    return branches.map((b, i) => ({ name: b.name, troveManager: b.troveManager, stabilityPool: a[2 * i], activePool: ap[i] }));
}

// One sample of every branch at a block: debt (TroveManager), Stability Pool deposits, the average interest rate (the ActivePool's
// debt-weighted rate sum over its recorded debt: every trove and batch of the branch), the interest a year at the current rates (that sum,
// as Liquity accrues it: calcPendingAggInterest) and the pool's share of the interest accrued since the last mint (calcPendingSPYield)
async function readSample(provider, contracts, block) {
    const calls = [[MULTICALL3, I.mc, 'getCurrentBlockTimestamp'], ...contracts.flatMap(c => [[c.troveManager, I.tm, 'getEntireBranchDebt'],
        [c.stabilityPool, I.sp, 'getTotalBoldDeposits'], [c.activePool, I.ap, 'aggWeightedDebtSum'], [c.activePool, I.ap, 'aggRecordedDebt'],
        [c.activePool, I.ap, 'calcPendingSPYield']])];
    const r = await multicall(provider, calls, block);
    const ts = Number(r[0]) * 1000;
    return contracts.map((c, i) => {
        const [debt, sp, weighted, recorded, pending] = r.slice(1 + 5 * i, 6 + 5 * i);
        return { branch: c.name, block, timestamp: ts, debt: num(debt), sp_deposits: num(sp), avg_rate: recorded > 0n ? Number(weighted * 10n ** 6n / recorded) / 1e22 : null,
            interest: Number(weighted / 10n ** 18n) / 1e18, pending_sp_yield: num(pending) };
    });
}

const sampleBounds = db.prepare('SELECT MAX(block) AS last FROM branch_samples');
const firstSample = db.prepare('SELECT MIN(block) AS b FROM branch_samples WHERE branch = ?');
const firstSampleBlock = { get: branch => firstSample.get(branch) };
// The 2-hour times from BACKFILL_FROM still to read, up to the time of the first live sample (branch_samples_backfill_to, set once).
// Each run reads them from the earliest and records its progress (branch_samples_backfill), so an interrupted run resumes where it stopped.
// Null before the first live sample.
function backfillGrid() {
    const to = getState.get('branch_samples_backfill_to')?.value;
    if (to == null) return null;
    const done = Number(getState.get('branch_samples_backfill')?.value ?? BACKFILL_FROM - BACKFILL_STEP), grid = [];
    for (let t = done + BACKFILL_STEP; t < Number(to) - BACKFILL_STEP / 2; t += BACKFILL_STEP) grid.push(t);
    return grid;
}

async function syncBatchManagers() {
    const snapshot = latestTroveSnapshot();
    if (!snapshot) return { skipped: 'no trove snapshot yet' };
    const to = Number(getState.get('last_block')?.value);
    if (!to) return { skipped: 'redemptions not synced yet' };
    const out = {};

    // 1. Events, up to the block the redemptions are synced to
    if (process.env.ETHERSCAN_API_KEY) {
        let requests = 0, added = 0;
        for (const b of snapshot.branches) {
            const key = `batch_events_block:${b.name}`;
            let from = Number(getState.get(key)?.value ?? START_BLOCK - 1) + 1;
            while (from <= to) {
                const logs = await getLogs(b.troveManager, from, to);
                requests++;
                // A full page may stop inside a block: the next request starts again at that block (events already stored are ignored)
                const full = logs.length >= FULL, last = full ? parseInt(logs[logs.length - 1].blockNumber, 16) : to;
                if (full && last <= from) throw new Error(`more than ${FULL} batch events in block ${from} on ${b.name}`);
                added += savePage(logs.map(l => decode(l, b.name)), key, full ? last - 1 : to);
                from = full ? last : to + 1;
                await sleep(250);                                          // Etherscan's free tier allows a few requests per second
            }
        }
        out.events = { requests, added, toBlock: to };
    } else out.events = { skipped: 'ETHERSCAN_API_KEY is not set' };

    // 2. Branch samples: one at the trove snapshot's block, then any missing history every 2 hours from BACKFILL_FROM
    const provider = makeProvider();
    const contracts = await branchContracts(provider, snapshot.branches);
    let samples = 0;
    if ((sampleBounds.get().last ?? 0) < snapshot.block) {
        const rows = await readSample(provider, contracts, snapshot.block);
        samples += saveSamples(rows);
        if (getState.get('branch_samples_backfill_to') == null) setState.run('branch_samples_backfill_to', String(Math.round(rows[0].timestamp / 1000)));
    }
    const grid = backfillGrid() ?? [];
    if (grid.length) {
        // blocks for the grid's times, from the average block time over the last ~42 days; each sample stores its block's own time
        const head = await withRetry(() => provider.getBlock(snapshot.block)), ref = await withRetry(() => provider.getBlock(snapshot.block - 300000));
        const perBlock = (head.timestamp - ref.timestamp) / 300000;
        for (let i = 0; i < grid.length; i += BACKFILL_CONCURRENCY) {
            const part = grid.slice(i, i + BACKFILL_CONCURRENCY);
            const rows = await Promise.all(part.map(t => readSample(provider, contracts, Math.round(head.number - (head.timestamp - t) / perBlock))));
            samples += saveSamples(rows.flat());
            setState.run('branch_samples_backfill', String(part.at(-1)));
        }
    }
    // BOLD minted to each pool, from its first sample (once the history is complete, so the start is the history's)
    if (process.env.ETHERSCAN_API_KEY && backfillGrid()?.length === 0) {
        let requests = 0, mints = 0;
        const budget = new Map();                                          // per branch and exploit transaction: its fees' share not yet assigned
        const toY = sampleBounds.get().last;                               // up to the latest sample, which every mint then has
        for (const c of contracts) {
            let from = Number(getState.get(`sp_yield_block:${c.name}`)?.value ?? firstSampleBlock.get(c.name).b - 1) + 1;
            const pos = () => (getState.get(`sp_yield_pos:${c.name}`)?.value ?? '0:-1').split(':').map(Number);
            const topics = `&topic0=${TRANSFER}&topic0_1_opr=and&topic1=${ZERO_TOPIC}&topic1_2_opr=and&topic2=0x${c.stabilityPool.slice(2).toLowerCase().padStart(64, '0')}`;
            while (from <= toY) {
                const logs = (await getLogs(BOLD, from, toY, topics)).map(l => ({ block: parseInt(l.blockNumber, 16), index: parseInt(l.logIndex, 16),
                    tx: l.transactionHash.toLowerCase(), amount: num(BigInt(l.data)) })).sort((a, b) => a.block - b.block || a.index - b.index);
                requests++;
                const [pb, pi] = pos(), fresh = logs.filter(l => l.block > pb || (l.block === pb && l.index > pi));
                const full = logs.length >= FULL, last = full ? logs.at(-1).block : toY;
                if (full && last <= from) throw new Error(`more than ${FULL} Stability Pool mints in block ${from} on ${c.name}`);
                mints += saveYield(c.name, fresh, fresh.length ? `${fresh.at(-1).block}:${fresh.at(-1).index}` : null, full ? last - 1 : toY, budget);
                from = full ? last : toY + 1;
                await sleep(250);
            }
        }
        out.spYield = { requests, mints };
    }
    out.samples = { added: samples, backfilled: grid.length, pruned: pruneSamples.run(Date.now() - 7 * 864e5,
        Number(getState.get('branch_samples_backfill_to')?.value ?? Number.MAX_SAFE_INTEGER / 1000) * 1000).changes };

    // 3. Liquity's list of known delegates, once a day; the last good copy is kept
    const read = Number(getState.get('known_delegates_at')?.value ?? 0);
    if (Date.now() - read > 864e5) {
        try {
            const list = await fetch(KNOWN_DELEGATES_URL, { signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
            const named = parseDelegates(list);
            if (!named.size) throw new Error('no delegates in the list');
            setState.run('known_delegates', JSON.stringify(list));
            setState.run('known_delegates_at', String(Date.now()));
            out.delegates = named.size;
        } catch (e) {
            out.delegates = `not read (${e.message}); the last copy is used`;
        }
    }
    return out;
}

// Address → [operator, strategy] from Liquity's list ([{ name, strategies: [{ name, address }] }])
function parseDelegates(list) {
    const named = new Map();
    for (const op of Array.isArray(list) ? list : []) for (const s of op.strategies || []) {
        if (typeof s.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s.address) && op.name) named.set(s.address.toLowerCase(), [String(op.name), String(s.name || '')]);
    }
    return named;
}

// Address (lowercase) → [operator, strategy]: Liquity's list (the last copy read, else the built-in one) and OTHER_NAMES
function managerNames() {
    const names = new Map(KNOWN_DELEGATES.flatMap(([op, strategy, addrs]) => addrs.map(a => [a, [op, strategy]])));
    const stored = getState.get('known_delegates')?.value;
    if (stored) for (const [a, n] of parseDelegates(JSON.parse(stored))) names.set(a, n);
    for (const [a, n] of Object.entries(OTHER_NAMES)) if (!names.has(a)) names.set(a, n);
    return names;
}

const eventsQuery = db.prepare(`SELECT block, timestamp, branch, manager, operation, debt, interest_rate, interest_rate_raw, management_fee,
    upfront_fee FROM batch_events ORDER BY block, log_index`);
const latestSample = db.prepare('SELECT MAX(timestamp) AS t FROM branch_samples WHERE block <= ?');
const samplesQuery = db.prepare(`SELECT branch, block, timestamp, debt, sp_deposits, avg_rate, interest, pending_sp_yield, sp_minted, sp_minted_incident FROM branch_samples
    WHERE timestamp >= ? AND block <= ? ORDER BY block`);
const branchRedeemedQuery = db.prepare(`SELECT r.timestamp, t.branch, t.tx_hash, SUM(t.debt_redeemed) AS bold FROM redemption_troves t
    JOIN redemptions r ON r.tx_hash = t.tx_hash WHERE r.timestamp >= ? GROUP BY t.tx_hash, t.branch ORDER BY r.timestamp`);
const hitsQuery = db.prepare(`SELECT t.tx_hash, r.timestamp, t.branch, t.batch_manager, SUM(t.debt_redeemed) AS bold FROM redemption_troves t
    JOIN redemptions r ON r.tx_hash = t.tx_hash WHERE t.batch_manager IS NOT NULL AND r.timestamp >= ? GROUP BY t.tx_hash, t.branch, t.batch_manager`);

// Time-weighted mean of a step series [[t, value]] (each value holds until the next point; the last until t1) over [t0, t1]
function weighted(series, t0, t1) {
    let area = 0, span = 0;
    series.forEach(([t, v], i) => {
        const a = Math.max(t, t0), b = Math.min(i + 1 < series.length ? series[i + 1][0] : t1, t1);
        if (b > a && v != null) { area += v * (b - a); span += b - a; }
    });
    return span ? area / span : null;
}

const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;

// batch_managers.json: every batch with its operator, rate, fee, debt and troves now, its rate steps, rate changes, raises just above
// another batch and redemption hits over the last 90 days and its score; each branch's samples over the same period, one per 2 hours
// plus the latest, and its redemptions. Times in seconds. Null until the history is complete.
function batchManagersExport() {
    const snapshot = latestTroveSnapshot();
    // nothing until the history is complete (a partial history would draw lines across the gap and skew the averages) and the pools' mints
    // have been read once; then the samples up to the block every pool's mints are read to, so a sync that fails partway leaves the file
    // one update behind rather than without it
    if (!snapshot || backfillGrid()?.length !== 0) return null;
    const minted = snapshot.branches.map(b => getState.get(`sp_yield_block:${b.name}`)?.value);
    if (minted.some(v => v == null)) return null;
    const upTo = Math.min(...minted.map(Number)), latest = latestSample.get(upTo).t;
    if (latest == null) return null;
    const sampleRows = samplesQuery.all(latest - (WINDOW + 86400) * 1000, upTo);
    const end = Math.round(sampleRows.at(-1).timestamp / 1000), start = end - WINDOW;
    const branches = snapshot.branches.map(b => b.name);
    const names = managerNames();
    const excluded = new Set(require('./public/incidents.json').incidents.flatMap(i => i.txs));

    // Each branch's samples: the latest in each 2-hour step of the period (from 6 hours before it, so every period has a sample at or before
    // its start), and the very latest: [time, debt, pool deposits, average rate, interest a year, pool yield not yet minted, BOLD minted to
    // the pool since the previous sample exported, the part of it minted in an exploit's transactions]. The BOLD minted in the samples left
    // out is added to the next one kept
    const branchOut = {}, perBranch = {};
    for (const br of branches) {
        const rows = sampleRows.filter(s => s.branch === br).map(s => ({ ...s, t: Math.round(s.timestamp / 1000) }));
        perBranch[br] = rows;
        const steps = new Map();
        for (const s of rows) {
            if (s.t < start - 6 * 3600) continue;
            const k = Math.floor(s.t / BACKFILL_STEP), prev = steps.get(k);
            steps.set(k, { ...s, minted: (prev ? prev.minted : 0) + s.sp_minted, mintedIncident: (prev ? prev.mintedIncident : 0) + s.sp_minted_incident });
        }
        branchOut[br] = { samples: [...steps.values()].map(s => [s.t, Math.round(s.debt), Math.round(s.sp_deposits), s.avg_rate == null ? null : r3(s.avg_rate),
            Math.round(s.interest), r2(s.pending_sp_yield), r2(s.minted), r2(s.mintedIncident)]) };
    }
    // Each branch's redemptions over the period: [time, BOLD redeemed from the branch, 1 if during an exploit]
    for (const br of branches) branchOut[br].redeemed = [];
    for (const r of branchRedeemedQuery.iterate(start * 1000)) branchOut[r.branch]?.redeemed.push([Math.round(r.timestamp / 1000), r2(r.bold), excluded.has(r.tx_hash) ? 1 : 0]);
    // Average rate of all BOLD borrowers over time: the branches' average rates weighted by their debt, at the times of the samples
    const byTime = new Map();
    for (const br of branches) for (const s of perBranch[br]) { const x = byTime.get(s.t) ?? { w: 0, d: 0, n: 0 }; if (s.avg_rate != null) { x.w += s.avg_rate * s.debt; x.d += s.debt; x.n++; } byTime.set(s.t, x); }
    const systemRate = [...byTime].filter(([, x]) => x.n === branches.length && x.d).sort((a, b) => a[0] - b[0]).map(([t, x]) => [t, x.w / x.d]);

    // Walk the events per branch in order, keeping each batch's rate (exact), its adjustment time and the time of its last raise
    const batches = new Map(), state = Object.fromEntries(branches.map(b => [b, new Map()]));
    for (const e of eventsQuery.iterate()) {
        if (!state[e.branch]) continue;
        const t = Math.round(e.timestamp / 1000), st = state[e.branch], prev = st.get(e.manager), raw = BigInt(e.interest_rate_raw);
        const key = `${e.branch}:${e.manager}`;
        const b = batches.get(key) ?? { branch: e.branch, manager: e.manager, registered: t, steps: [], changes: [], leaps: [] };
        batches.set(key, b);
        b.steps.push([t, e.interest_rate, e.debt, e.management_fee]);
        const changed = e.operation === SET_RATE && prev && raw !== prev.raw;
        if (changed) {
            const early = prev.adjusted != null && t - prev.adjusted < COOLDOWN;
            let over = [];
            if (raw > prev.raw) {
                // the batches it moved above: at or above its old rate, below its new one, and raised within LEAP_WINDOW before
                over = [...st].filter(([m, s]) => m !== e.manager && prev.raw <= s.raw && s.raw < raw && s.raised != null && t - s.raised <= LEAP_WINDOW).map(([m]) => m);
            }
            b.changes.push([t, prev.rate, e.interest_rate, early, e.upfront_fee]);
            if (over.length) b.leaps.push([t, over]);
        }
        st.set(e.manager, {
            rate: e.interest_rate, raw,
            adjusted: e.operation === SET_RATE || e.operation === 'registerBatchManager' ? t : prev?.adjusted ?? null,
            raised: changed && raw > prev.raw ? t : prev?.raised ?? null
        });
    }
    // Redemption hits: one per redemption transaction that redeemed at least one of the batch's troves
    const hits = new Map();
    for (const h of hitsQuery.iterate(start * 1000)) {
        const key = `${h.branch}:${h.batch_manager.toLowerCase()}`;
        if (!hits.has(key)) hits.set(key, []);
        hits.get(key).push([Math.round(h.timestamp / 1000), r2(h.bold), excluded.has(h.tx_hash) ? 1 : 0]);
    }
    for (const list of hits.values()) list.sort((a, b) => a[0] - b[0]);
    // Debt and troves now, from the trove snapshot (debt with the interest accrued since the last event)
    const index = new Map(snapshot.branches.map(b => [b.index, b.name]));
    const snapManagers = new Map(snapshot.managers.map(m => [`${index.get(m.branch)}:${m.address.toLowerCase()}`, m]));
    const troveCount = new Map();
    for (const t of snapshot.troves) if (t.status === 1 && t.batchManager) { const k = `${index.get(t.branch)}:${t.batchManager.toLowerCase()}`; troveCount.set(k, (troveCount.get(k) || 0) + 1); }

    const sysAvg = weighted(systemRate, start, end);
    const out = [];
    for (const [key, b] of batches) {
        const last = b.steps.at(-1), [operator, strategy] = names.get(b.manager) ?? ['Unidentified', ''];
        const before = b.steps.filter(s => s[0] < start).at(-1);
        const steps = [...(before ? [[start, ...before.slice(1)]] : []), ...b.steps.filter(s => s[0] >= start)];
        const avgDebt = weighted(steps.map(s => [s[0], s[2]]), start, end) ?? 0;
        const changes = b.changes.filter(c => c[0] >= start), leaps = b.leaps.filter(l => l[0] >= start), h = hits.get(key) ?? [];
        let score = null;
        if (avgDebt >= MIN_SCORED_DEBT && sysAvg != null) {
            const years = WINDOW / (365 * 86400), months = WINDOW / (30 * 86400);
            const avgRate = weighted(steps.map(s => [s[0], s[1]]), start, end), avgFee = weighted(steps.map(s => [s[0], s[3]]), start, end);
            const upfront = changes.reduce((a, c) => a + c[4], 0);
            const values = {
                rate: avgRate - sysAvg,
                fees: (avgFee / 100 * years * avgDebt + upfront) / avgDebt * 100,
                chasing: leaps.length / months,
                redeemed: h.reduce((a, x) => a + x[1], 0) / avgDebt * 100
            };
            const parts = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: r2(v), points: Math.round(25 * (1 - Math.min(Math.max(v / SCORE[k].zeroAt, 0), 1)) * 10) / 10 }]));
            score = { total: Math.round(Object.values(parts).reduce((a, p) => a + p.points, 0)), parts };
        }
        const snap = snapManagers.get(key);
        out.push({
            branch: b.branch, manager: b.manager, operator, strategy, registered: new Date(b.registered * 1000).toISOString().slice(0, 10),
            debt: Math.round(snap ? snap.debt : last[2]), rate: r3(last[1]), fee: r3(last[3]), troves: troveCount.get(key) ?? 0, score,
            // [time, rate, debt]: the state at the start of the period, then every event
            steps: steps.map(s => [s[0], r3(s[1]), Math.round(s[2])]),
            // [time, old rate, new rate, early (1/0), upfront fee in BOLD]
            changes: changes.map(c => [c[0], r3(c[1]), r3(c[2]), c[3] ? 1 : 0, Math.round(c[4])]),
            // [time, [the batches it moved above, by name]]
            leaps: leaps.map(([t, over]) => [t, over.map(m => { const n = names.get(m) ?? ['Unidentified', '']; return n[1] ? `${n[0]} ${n[1]}` : n[0]; })]),
            // [time, BOLD redeemed from its troves, 1 if during an exploit]
            hits: h
        });
    }
    out.sort((a, b) => branches.indexOf(a.branch) - branches.indexOf(b.branch) || b.debt - a.debt);
    return { end, windowStart: start, cooldownDays: COOLDOWN / 86400, leapWindowHours: LEAP_WINDOW / 3600, minScoredDebt: MIN_SCORED_DEBT, score: SCORE,
        branches: branchOut, batches: out };
}

module.exports = { syncBatchManagers, batchManagersExport, managerNames };

if (require.main === module) {
    syncBatchManagers()
        .then(r => console.log(`Batch managers: ${JSON.stringify(r)}`))
        .catch(e => { console.error(e.message); process.exit(1); });
}
