// Snapshot of every open trove in Liquity V2, for the Troves tab. Read-only calls at one block (a few blocks behind
// the head), bundled through Multicall3: about eight calls per snapshot, plus one at the block about 30 days earlier (the
// number of active troves then). The result is stored as one JSON document in the
// trove_snapshot table; the page computes queue positions, debt in front and the other derived figures from it.
// Independent of the redemption sync (worker.js): export.js and index.js call snapshotTroves() after each sync, and a failure
// here leaves the redemption data untouched.
const { ethers } = require('ethers');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');

const env = (key, fallback) => process.env[key] || fallback;
const REGISTRY = env('LIQUITY_V2_REDEMPTION_ADDRESS', '0xf949982B91C8c61e952B3bA942cbbfaef5386684');
const CURVE_POOL = env('CURVE_POOL_ADDRESS_BOLD_USDC', '0xEFc6516323FbD28e80B85A497B65A86243a54B3E');
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ETH_USDC_POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';      // Uniswap v3 USDC/WETH 0.05%, as in worker.js
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
// Liquity's MultiTroveGetter (verified on Etherscan; created by the deployer of the CollateralRegistry)
const MULTI_TROVE_GETTER = '0xfa61db085510c64b83056db3a7acf3b6f631d235';
// Branch price feeds have no public getter on the branch contracts; verified on Etherscan and by their lastGoodPrice
const PRICE_FEEDS = ['0xcc5f8102eb670c89a4a3c567c13851260303c24f', '0xe7aa2ba9e086a379d3beb224098bc634a46e314e', '0x34f1e9c7dcc279ec70d3c4488eb2d80fba8b7b2b'];
const CONFIRMATIONS = 3;
const CHUNK = 250;                                                         // calls per Multicall3 batch

const I = {
    mc: new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
        'function getCurrentBlockTimestamp() view returns (uint256)']),
    reg: new ethers.Interface(['function totalCollaterals() view returns (uint256)', 'function getTroveManager(uint256) view returns (address)',
        'function getToken(uint256) view returns (address)', 'function getRedemptionRateWithDecay() view returns (uint256)']),
    tm: new ethers.Interface(['function troveNFT() view returns (address)', 'function stabilityPool() view returns (address)',
        'function borrowerOperations() view returns (address)', 'function getEntireBranchDebt() view returns (uint256)',
        'function getEntireBranchColl() view returns (uint256)', 'function lastZombieTroveId() view returns (uint256)',
        'function getTroveIdsCount() view returns (uint256)', 'function getTroveFromTroveIdsArray(uint256) view returns (uint256)',
        'function getTroveStatus(uint256) view returns (uint8)',
        'function getLatestTroveData(uint256) view returns ((uint256 entireDebt, uint256 entireColl, uint256 redistBoldDebtGain, uint256 redistCollGain, uint256 accruedInterest, uint256 recordedDebt, uint256 annualInterestRate, uint256 weightedRecordedDebt, uint256 accruedBatchManagementFee, uint256 lastInterestRateAdjTime))',
        'function getLatestBatchData(address) view returns ((uint256 totalDebtShares, uint256 entireDebtWithoutRedistribution, uint256 entireCollWithoutRedistribution, uint256 accruedInterest, uint256 recordedDebt, uint256 annualInterestRate, uint256 weightedRecordedDebt, uint256 annualManagementFee, uint256 accruedManagementFee, uint256 weightedRecordedBatchManagementFee, uint256 lastDebtUpdateTime, uint256 lastInterestRateAdjTime))']),
    bo: new ethers.Interface(['function MCR() view returns (uint256)', 'function CCR() view returns (uint256)', 'function SCR() view returns (uint256)',
        'function addManagerOf(uint256) view returns (address)', 'function removeManagerReceiverOf(uint256) view returns (address manager, address receiver)',
        'function interestBatchManagerOf(uint256) view returns (address)',
        'function getInterestIndividualDelegateOf(uint256) view returns ((address account, uint128 minInterestRate, uint128 maxInterestRate, uint256 minInterestRateChangePeriod))',
        'function getInterestBatchManager(address) view returns ((uint128 minInterestRate, uint128 maxInterestRate, uint256 minInterestRateChangePeriod))']),
    sp: new ethers.Interface(['function getTotalBoldDeposits() view returns (uint256)']),
    pf: new ethers.Interface(['function lastGoodPrice() view returns (uint256)']),
    nft: new ethers.Interface(['function ownerOf(uint256) view returns (address)']),
    erc20: new ethers.Interface(['function symbol() view returns (string)']),
    mtg: new ethers.Interface(['function getMultipleSortedTroves(uint256 _collIndex, int256 _startIdx, uint256 _count) view returns ((uint256 id, uint256 entireDebt, uint256 entireColl, uint256 redistBoldDebtGain, uint256 redistCollGain, uint256 accruedInterest, uint256 recordedDebt, uint256 annualInterestRate, uint256 accruedBatchManagementFee, uint256 lastInterestRateAdjTime, uint256 stake, uint256 lastDebtUpdateTime, address interestBatchManager, uint256 batchDebtShares, uint256 snapshotETH, uint256 snapshotBoldDebt)[] _troves)']),
    pool: new ethers.Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)']),
    curve: new ethers.Interface(['function get_p(uint256) view returns (uint256)', 'function coins(uint256) view returns (address)']),
    lst: new ethers.Interface(['function stEthPerToken() view returns (uint256)', 'function getExchangeRate() view returns (uint256)'])
};
const LST_RATE = { wstETH: 'stEthPerToken', rETH: 'getExchangeRate' };

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
            await new Promise(r => setTimeout(r, 500 * 2 ** i * (0.75 + Math.random() / 2)));
        }
    }
}

const num = v => Number(ethers.formatEther(v));
const addr = a => (a && a !== ethers.ZeroAddress ? a.toLowerCase() : null);

// Calls: [target, interface, function, args, allowFailure]; returns decoded results (null for a failed optional call)
async function multicall(provider, calls, blockTag) {
    const out = [];
    for (let i = 0; i < calls.length; i += CHUNK) {
        const part = calls.slice(i, i + CHUNK);
        const data = I.mc.encodeFunctionData('aggregate3', [part.map(([target, iface, fn, args = [], allowFailure = false]) =>
            ({ target, allowFailure, callData: iface.encodeFunctionData(fn, args) }))]);
        const raw = await withRetry(() => provider.call({ to: MULTICALL3, data, blockTag }));
        const res = I.mc.decodeFunctionResult('aggregate3', raw)[0];
        res.forEach((r, j) => {
            const [, iface, fn] = part[j];
            out.push(r.success && r.returnData !== '0x' ? iface.decodeFunctionResult(fn, r.returnData) : null);
        });
    }
    return out;
}

const insertSnapshot = db.prepare('INSERT OR REPLACE INTO trove_snapshot (id, taken_at, block, data) VALUES (1, ?, ?, ?)');
const readSnapshot = db.prepare('SELECT data FROM trove_snapshot WHERE id = 1');

async function snapshotTroves() {
    const provider = makeProvider();
    const block = (await withRetry(() => provider.getBlockNumber())) - CONFIRMATIONS;

    // 1. Branch contracts, from the CollateralRegistry
    const [[n]] = await multicall(provider, [[REGISTRY, I.reg, 'totalCollaterals']], block);
    const idx = [...Array(Number(n)).keys()];
    const regRes = await multicall(provider, idx.flatMap(i => [[REGISTRY, I.reg, 'getTroveManager', [i]], [REGISTRY, I.reg, 'getToken', [i]]]), block);
    const branches = idx.map(i => ({ index: i, troveManager: regRes[2 * i][0], token: regRes[2 * i + 1][0], priceFeed: PRICE_FEEDS[i] }));
    const wiring = await multicall(provider, branches.flatMap(b => [[b.troveManager, I.tm, 'troveNFT'], [b.troveManager, I.tm, 'stabilityPool'],
        [b.troveManager, I.tm, 'borrowerOperations'], [b.token, I.erc20, 'symbol']]), block);
    branches.forEach((b, i) => Object.assign(b, { troveNFT: wiring[4 * i][0], stabilityPool: wiring[4 * i + 1][0], borrowerOperations: wiring[4 * i + 2][0],
        name: wiring[4 * i + 3][0] }));

    // 2. Branch state, prices, and every branch's sorted list (from the lowest interest rate up: redemption order)
    const curveCoin0 = (await multicall(provider, [[CURVE_POOL, I.curve, 'coins', [0]]], block))[0][0];
    const main = await multicall(provider, [
        [MULTICALL3, I.mc, 'getCurrentBlockTimestamp'], [REGISTRY, I.reg, 'getRedemptionRateWithDecay'],
        [ETH_USDC_POOL, I.pool, 'slot0'], [CURVE_POOL, I.curve, 'get_p', [0], true],
        ...branches.flatMap(b => [
            [b.troveManager, I.tm, 'getEntireBranchDebt'], [b.troveManager, I.tm, 'getEntireBranchColl'], [b.stabilityPool, I.sp, 'getTotalBoldDeposits'],
            [b.troveManager, I.tm, 'lastZombieTroveId'], [b.troveManager, I.tm, 'getTroveIdsCount'], [b.priceFeed, I.pf, 'lastGoodPrice'],
            [b.borrowerOperations, I.bo, 'MCR'], [b.borrowerOperations, I.bo, 'CCR'], [b.borrowerOperations, I.bo, 'SCR'],
            [MULTI_TROVE_GETTER, I.mtg, 'getMultipleSortedTroves', [b.index, -1, 5000]],
            LST_RATE[b.name] ? [b.token, I.lst, LST_RATE[b.name], [], true] : [MULTICALL3, I.mc, 'getCurrentBlockTimestamp']])], block);
    const [[ts], [redemptionRate], slot0, curveP] = main;
    const ethUsd = 1e12 / (Number(slot0[0]) / 2 ** 96) ** 2;
    const boldUsd = curveP ? (curveCoin0.toLowerCase() === USDC.toLowerCase() ? num(curveP[0]) : 1 / num(curveP[0])) : null;
    const sorted = {};
    branches.forEach((b, i) => {
        const r = main.slice(4 + i * 11, 4 + (i + 1) * 11);
        Object.assign(b, { debt: num(r[0][0]), coll: num(r[1][0]), spDeposits: num(r[2][0]), lastZombie: r[3][0] > 0n ? ethers.toBeHex(r[3][0], 32) : null,
            troveCount: Number(r[4][0]), oraclePrice: num(r[5][0]), mcr: num(r[6][0]), ccr: num(r[7][0]), scr: num(r[8][0]),
            lstRate: LST_RATE[b.name] ? (r[10] ? num(r[10][0]) : null) : 1 });
        b.marketPrice = b.lstRate != null ? ethUsd * b.lstRate : null;
        sorted[b.index] = r[9][0];
    });

    // 3. Every trove id (sorted list and zombies), then owner, permissions, status; zombies are not in the sorted list
    const idCalls = branches.flatMap(b => [...Array(b.troveCount).keys()].map(k => [b.troveManager, I.tm, 'getTroveFromTroveIdsArray', [k]]));
    const ids = await multicall(provider, idCalls, block);
    let at = 0;
    const troveRefs = [];
    for (const b of branches) {
        for (let k = 0; k < b.troveCount; k++) troveRefs.push({ b, id: ids[at++][0] });
    }
    const perTrove = await multicall(provider, troveRefs.flatMap(({ b, id }) => [
        [b.troveNFT, I.nft, 'ownerOf', [id], true], [b.troveManager, I.tm, 'getTroveStatus', [id]], [b.borrowerOperations, I.bo, 'addManagerOf', [id]],
        [b.borrowerOperations, I.bo, 'removeManagerReceiverOf', [id]], [b.borrowerOperations, I.bo, 'getInterestIndividualDelegateOf', [id]],
        [b.troveManager, I.tm, 'getLatestTroveData', [id]], [b.borrowerOperations, I.bo, 'interestBatchManagerOf', [id]]]), block);

    const queueOrder = new Map();                                          // "branch:id" -> position in the sorted list
    for (const b of branches) sorted[b.index].forEach((t, pos) => queueOrder.set(`${b.index}:${ethers.toBeHex(t.id, 32)}`, pos));
    const troves = troveRefs.map(({ b, id }, i) => {
        const [owner, status, addManager, rm, delegate, data, batchMgr] = perTrove.slice(7 * i, 7 * i + 7);
        const d = data[0];
        const hex = ethers.toBeHex(id, 32);
        const del = delegate[0];
        return {
            branch: b.index, id: hex, owner: owner ? addr(owner[0]) : null, status: Number(status[0]),
            queue: queueOrder.has(`${b.index}:${hex}`) ? queueOrder.get(`${b.index}:${hex}`) : null,
            debt: num(d.entireDebt), coll: num(d.entireColl), rate: num(d.annualInterestRate) * 100, lastRateChange: Number(d.lastInterestRateAdjTime),
            accruedInterest: num(d.accruedInterest), accruedBatchFee: num(d.accruedBatchManagementFee),
            redistDebt: num(d.redistBoldDebtGain), redistColl: num(d.redistCollGain), batchManager: addr(batchMgr[0]),
            addManager: addr(addManager[0]), removeManager: addr(rm[0]), receiver: addr(rm[1]),
            delegate: addr(del.account) ? { account: addr(del.account), minRate: num(del.minInterestRate) * 100, maxRate: num(del.maxInterestRate) * 100,
                minChangePeriod: Number(del.minInterestRateChangePeriod) } : null
        };
    });

    // 4. Batch managers
    const managers = [...new Set(troves.filter(t => t.batchManager).map(t => `${t.branch}:${t.batchManager}`))].map(k => {
        const [bi, a] = k.split(':'); return { branch: Number(bi), address: a };
    });
    const mres = await multicall(provider, managers.flatMap(m => [[branches[m.branch].troveManager, I.tm, 'getLatestBatchData', [m.address]],
        [branches[m.branch].borrowerOperations, I.bo, 'getInterestBatchManager', [m.address]]]), block);
    managers.forEach((m, i) => {
        const d = mres[2 * i][0], c = mres[2 * i + 1][0];
        Object.assign(m, { debt: num(d.entireDebtWithoutRedistribution), coll: num(d.entireCollWithoutRedistribution), rate: num(d.annualInterestRate) * 100,
            fee: num(d.annualManagementFee) * 100, lastRateChange: Number(d.lastInterestRateAdjTime), minRate: num(c.minInterestRate) * 100,
            maxRate: num(c.maxInterestRate) * 100, minChangePeriod: Number(c.minInterestRateChangePeriod) });
    });

    // 5. Active troves about 30 days earlier, for the change shown on the page: the length of every branch's sorted list
    // (zombies are not in it) at the block 30 days of 12-second slots back. Optional: a node without history fails here,
    // and the page then shows no change
    let past = null;
    try {
        const pastBlock = block - Math.round(30 * 86400 / 12);
        const pr = await multicall(provider, [[MULTICALL3, I.mc, 'getCurrentBlockTimestamp'],
            ...branches.map(b => [MULTI_TROVE_GETTER, I.mtg, 'getMultipleSortedTroves', [b.index, -1, 5000]])], pastBlock);
        const byBranch = pr.slice(1).map(r => r[0].length);
        past = { block: pastBlock, ts: Number(pr[0][0]), active: byBranch.reduce((a, v) => a + v, 0), byBranch };
    } catch (e) {
        console.warn(`Active troves 30 days ago unavailable: ${e.shortMessage || e.message}`);
    }

    const snapshot = {
        block, ts: Number(ts), ethUsd, boldUsd, redemptionRate: num(redemptionRate) * 100, past,
        branches: branches.map(b => ({ index: b.index, name: b.name, troveManager: b.troveManager.toLowerCase(), troveNFT: b.troveNFT.toLowerCase(),
            debt: b.debt, coll: b.coll, spDeposits: b.spDeposits, oraclePrice: b.oraclePrice, marketPrice: b.marketPrice, lstRate: b.lstRate,
            mcr: b.mcr, ccr: b.ccr, scr: b.scr, lastZombie: b.lastZombie })),
        managers, troves
    };
    insertSnapshot.run(Date.now(), block, JSON.stringify(snapshot));
    return snapshot;
}

function latestTroveSnapshot() {
    const row = readSnapshot.get();
    return row ? JSON.parse(row.data) : null;
}

module.exports = { snapshotTroves, latestTroveSnapshot };

if (require.main === module) {
    snapshotTroves()
        .then(s => console.log(`Trove snapshot at block ${s.block}: ${s.troves.length} troves, ${s.managers.length} batch managers`))
        .catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
}
