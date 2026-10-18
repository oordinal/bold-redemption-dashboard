const { ethers } = require('ethers');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');

// Verified Liquity V2 (relaunch) mainnet addresses; any of them can be overridden in .env
const DEFAULTS = {
    BOLD_TOKEN_ADDRESS: '0x6440f144b7e50D6a8439336510312d2F54beB01D',
    LIQUITY_V2_REDEMPTION_ADDRESS: '0xf949982B91C8c61e952B3bA942cbbfaef5386684', // CollateralRegistry
    UNISWAP_V3_POOL_ADDRESS_BOLD_USDC: '0x1E4DBb639eBBF725fd243A6190dF5440eE38740E',
    UNISWAP_V4_POOL_MANAGER: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    UNISWAP_V4_POOL_ID_BOLD_USDC: '0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893',
    CURVE_POOL_ADDRESS_BOLD_USDC: '0xEFc6516323FbD28e80B85A497B65A86243a54B3E',
    START_BLOCK: '22516069' // CollateralRegistry deployment block
};
const env = key => process.env[key] || DEFAULTS[key];

const START_BLOCK = Number(env('START_BLOCK'));
const CONFIRMATIONS = 3;
const SCAN_CHUNK = 100000; // blocks per scan pass; progress is saved after each one
// Bump to make existing databases rescan the whole history once. v2: BOLD-burn discovery,
// which replaced public-RPC eth_getLogs scans that silently returned empty ranges.
// v3: collateral valued at the ETH/USDC price at the moment of the redemption (ethPriceBeforeTx).
// v4: flash-loan venue and BOLD sources per redemption (flashVenues, boldSources).
const SCAN_VERSION = '4';
const ENRICH_CONCURRENCY = 4;

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
// Uniswap v3 USDC/WETH 0.05%, the reference ETH market price
const ETH_USDC_POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const UNI_V3_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
// Flash-loan events, keyed by topic; a venue is named only when the event comes from its known contract
// (Uniswap v3 Flash comes from any pool). Financing without such an event is found by flashSwapVenue.
const FLASH_EVENTS = {
    [ethers.id('FlashLoan(address,address,uint256)')]: { '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb': 'Morpho' },
    [ethers.id('FlashLoan(address,address,uint256,uint256)')]: {
        '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer', '0x60744434d6339a6b27d73d9eda62b6f66a0a04fa': 'Maker'
    },
    [ethers.id('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)')]: {
        '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': 'Aave', '0xc13e21b648a5ee794902342038ff3adab66be987': 'Spark'
    },
    [ethers.id('Flash(address,address,uint256,uint256,uint256,uint256)')]: '*Uniswap v3 flash loan'
};
const FLASH_LENDERS = new Set(Object.values(FLASH_EVENTS).flatMap(v => typeof v === 'string' ? [] : Object.keys(v)));
const UNI_V4_POOL_MANAGER_ADDRESS = '0x000000000004444c5dc75cb358380d2e3de08a90';
const BALANCER_V3_VAULT = '0xba1333333333a1ba1108e8412f11850a5c319ba9';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const COLLATERAL_REGISTRY_ABI = [
    'function totalCollaterals() view returns (uint256)',
    'function getTroveManager(uint256) view returns (address)',
    'function getToken(uint256) view returns (address)'
];
const ERC20_ABI = ['function symbol() view returns (string)'];
const TROVE_MANAGER = new ethers.Interface([
    'event Redemption(uint256 _attemptedBoldAmount, uint256 _actualBoldAmount, uint256 _ETHSent, uint256 _ETHFee, uint256 _price, uint256 _redemptionPrice)'
]);
const REDEMPTION_TOPIC = TROVE_MANAGER.getEvent('Redemption').topicHash;
// Per-trove events of a redemption, emitted in this order for each trove:
// (TroveUpdated | BatchedTroveUpdated), TroveOperation, [BatchUpdated], RedemptionFeePaidToTrove
const TROVE_EVENTS = new ethers.Interface([
    'event TroveUpdated(uint256 indexed _troveId, uint256 _debt, uint256 _coll, uint256 _stake, uint256 _annualInterestRate, uint256 _snapshotOfTotalCollRedist, uint256 _snapshotOfTotalDebtRedist)',
    'event BatchedTroveUpdated(uint256 indexed _troveId, address _interestBatchManager, uint256 _batchDebtShares, uint256 _coll, uint256 _stake, uint256 _snapshotOfTotalCollRedist, uint256 _snapshotOfTotalDebtRedist)',
    'event TroveOperation(uint256 indexed _troveId, uint8 _operation, uint256 _annualInterestRate, uint256 _debtIncreaseFromRedist, uint256 _debtIncreaseFromUpfrontFee, int256 _debtChangeFromOperation, uint256 _collIncreaseFromRedist, int256 _collChangeFromOperation)',
    'event BatchUpdated(address indexed _interestBatchManager, uint8 _operation, uint256 _debt, uint256 _coll, uint256 _annualInterestRate, uint256 _annualManagementFee, uint256 _totalDebtShares, uint256 _debtIncreaseFromUpfrontFee)',
    'event RedemptionFeePaidToTrove(uint256 indexed _troveId, uint256 _ETHFee)'
]);
const OP_REDEEM_COLLATERAL = 6n; // ITroveEvents.Operation.redeemCollateral
const UNI_V3_POOL = new ethers.Interface([
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    'function token0() view returns (address)'
]);
const UNI_V4_POOL_MANAGER = new ethers.Interface(['function extsload(bytes32) view returns (bytes32)']);
const CURVE_POOL = new ethers.Interface([
    'function get_p(uint256) view returns (uint256)',
    'function coins(uint256) view returns (address)'
]);
// LST -> ETH exchange rates, keyed by collateral symbol (WETH is 1:1)
const LST_RATE = { wstETH: 'stEthPerToken', rETH: 'getExchangeRate' };
const LST_RATE_IFACE = new ethers.Interface([
    'function stEthPerToken() view returns (uint256)',
    'function getExchangeRate() view returns (uint256)'
]);
const MULTICALL3_ABI = [
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])'
];

function makeProvider(url) {
    const req = new ethers.FetchRequest(url);
    req.timeout = 30000;
    return new ethers.JsonRpcProvider(req, 1, { staticNetwork: true, batchMaxCount: 10 });
}

// Alchemy (key or full URL). Its transfers API is required to find redemptions.
function mainRpcUrl() {
    const k = (process.env.RPC_URL || process.env.ALCHEMY_API_KEY || '').trim();
    if (!k) return 'https://ethereum-rpc.publicnode.com';
    return k.startsWith('http') ? k : `https://eth-mainnet.g.alchemy.com/v2/${k}`;
}

const provider = makeProvider(mainRpcUrl());
const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);

const state = {
    running: false,
    phase: 'idle',
    fromBlock: null,
    targetBlock: null,
    scannedTo: null,
    found: 0,
    processed: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null
};

const getState = db.prepare('SELECT value FROM sync_state WHERE key = ?');
const setState = db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)');
const insertEvent = db.prepare(`INSERT OR REPLACE INTO redemption_events
    (tx_hash, log_index, branch, bold_attempted, bold_redeemed, coll_sent, coll_fee, coll_price, redemption_price, coll_market_price)
    VALUES (@tx_hash, @log_index, @branch, @bold_attempted, @bold_redeemed, @coll_sent, @coll_fee, @coll_price, @redemption_price, @coll_market_price)`);
const insertRedemption = db.prepare(`INSERT OR REPLACE INTO redemptions
    (tx_hash, block, timestamp, sender, to_address, via_contract, branches, amount, coll_value_usd, fee_usd,
     price_curve, price_uni_v3, price_uni_v4, market_price, spread, oracle_gap, fee_pct, net_edge,
     gas_used, base_fee_eth, priority_fee_eth, coinbase_tip_eth, eth_usd,
     gross_profit_usd, gas_fee_usd, builder_tip_usd, net_profit_usd, net_margin,
     flash_venue, bold_src_curve, bold_src_uni_v3, bold_src_uni_v4, bold_src_other, bold_src_held)
    VALUES (@tx_hash, @block, @timestamp, @sender, @to_address, @via_contract, @branches, @amount, @coll_value_usd, @fee_usd,
     @price_curve, @price_uni_v3, @price_uni_v4, @market_price, @spread, @oracle_gap, @fee_pct, @net_edge,
     @gas_used, @base_fee_eth, @priority_fee_eth, @coinbase_tip_eth, @eth_usd,
     @gross_profit_usd, @gas_fee_usd, @builder_tip_usd, @net_profit_usd, @net_margin,
     @flash_venue, @bold_src_curve, @bold_src_uni_v3, @bold_src_uni_v4, @bold_src_other, @bold_src_held)`);

const insertTrove = db.prepare(`INSERT OR REPLACE INTO redemption_troves
    (tx_hash, log_index, branch, trove_id, interest_rate, debt_redeemed, coll_redeemed, fee_coll, debt_after, coll_after, batch_manager)
    VALUES (@tx_hash, @log_index, @branch, @trove_id, @interest_rate, @debt_redeemed, @coll_redeemed, @fee_coll, @debt_after, @coll_after, @batch_manager)`);
const txsWithoutTroves = db.prepare(`SELECT tx_hash FROM redemptions
    WHERE tx_hash NOT IN (SELECT DISTINCT tx_hash FROM redemption_troves) ORDER BY block`);

function lastSyncedBlock() {
    const row = getState.get('last_block');
    return row ? Number(row.value) : null;
}

// Retries with jittered backoff, which also absorbs Alchemy's per-second rate limit (HTTP 429)
async function withRetry(fn, attempts = 7) {
    for (let i = 0; ; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i >= attempts - 1) throw e;
            await new Promise(r => setTimeout(r, 400 * 2 ** i * (0.75 + Math.random() / 2)));
        }
    }
}

let config;

// Branches (TroveManager + collateral symbol) and pool orientation, read once from chain
async function loadConfig() {
    if (config) return config;

    const registryAddress = env('LIQUITY_V2_REDEMPTION_ADDRESS');
    if (!ethers.isAddress(registryAddress)) throw new Error('LIQUITY_V2_REDEMPTION_ADDRESS is not a valid address');
    const registry = new ethers.Contract(registryAddress, COLLATERAL_REGISTRY_ABI, provider);

    const branches = {};
    const n = Number(await withRetry(() => registry.totalCollaterals()));
    for (let i = 0; i < n; i++) {
        const [tm, token] = await Promise.all([registry.getTroveManager(i), registry.getToken(i)]);
        const symbol = await new ethers.Contract(token, ERC20_ABI, provider).symbol();
        branches[tm.toLowerCase()] = { symbol, token };
    }

    const pools = {};
    const v3 = env('UNISWAP_V3_POOL_ADDRESS_BOLD_USDC');
    if (ethers.isAddress(v3)) {
        const token0 = await new ethers.Contract(v3, UNI_V3_POOL, provider).token0();
        pools.uniV3 = { address: v3, boldIsToken0: token0.toLowerCase() !== USDC.toLowerCase() };
    }
    const poolManager = env('UNISWAP_V4_POOL_MANAGER');
    const v4Id = env('UNISWAP_V4_POOL_ID_BOLD_USDC');
    if (ethers.isAddress(poolManager) && ethers.isHexString(v4Id, 32)) {
        // v4 sorts currencies by address; Pool.State.slot0 lives at keccak(poolId, 6)
        const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [v4Id, 6]));
        pools.uniV4 = { address: poolManager, slot, boldIsToken0: BigInt(USDC) > BigInt(env('BOLD_TOKEN_ADDRESS')) };
    }
    const curve = env('CURVE_POOL_ADDRESS_BOLD_USDC');
    if (ethers.isAddress(curve)) {
        const coin0 = await new ethers.Contract(curve, CURVE_POOL, provider).coins(0);
        pools.curve = { address: curve, boldIsCoin0: coin0.toLowerCase() !== USDC.toLowerCase() };
    }

    config = { registryAddress: registryAddress.toLowerCase(), branches, pools };
    return config;
}

// BOLD (18 decimals) priced in USDC (6 decimals) from a Uniswap sqrtPriceX96
function priceFromSqrt(sqrtPriceX96, boldIsToken0) {
    if (sqrtPriceX96 === 0n) return null;
    const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1 per token0, raw units
    return boldIsToken0 ? raw * 1e12 : 1 / (raw * 1e12);
}

async function pricesAt(blockTag) {
    const { pools, branches } = config;
    const calls = [];
    const decoders = [];

    // Collateral market prices: ETH/USDC x each LST's ETH exchange rate
    calls.push({ target: ETH_USDC_POOL, allowFailure: true, callData: UNI_V3_POOL.encodeFunctionData('slot0') });
    decoders.push(['eth_usd', data => {
        const raw = (Number(UNI_V3_POOL.decodeFunctionResult('slot0', data)[0]) / 2 ** 96) ** 2; // WETH per USDC, raw units
        return 1e12 / raw;
    }]);
    for (const { symbol, token } of Object.values(branches)) {
        if (!LST_RATE[symbol]) continue;
        calls.push({ target: token, allowFailure: true, callData: LST_RATE_IFACE.encodeFunctionData(LST_RATE[symbol]) });
        decoders.push([`rate_${symbol}`, data => Number(ethers.formatEther(LST_RATE_IFACE.decodeFunctionResult(LST_RATE[symbol], data)[0]))]);
    }

    if (pools.uniV3) {
        calls.push({ target: pools.uniV3.address, allowFailure: true, callData: UNI_V3_POOL.encodeFunctionData('slot0') });
        decoders.push(['price_uni_v3', data => priceFromSqrt(UNI_V3_POOL.decodeFunctionResult('slot0', data)[0], pools.uniV3.boldIsToken0)]);
    }
    if (pools.uniV4) {
        calls.push({ target: pools.uniV4.address, allowFailure: true, callData: UNI_V4_POOL_MANAGER.encodeFunctionData('extsload', [pools.uniV4.slot]) });
        decoders.push(['price_uni_v4', data => {
            const word = UNI_V4_POOL_MANAGER.decodeFunctionResult('extsload', data)[0];
            return priceFromSqrt(BigInt(word) & ((1n << 160n) - 1n), pools.uniV4.boldIsToken0);
        }]);
    }
    if (pools.curve) {
        // get_p(0): price of coin 1 in units of coin 0, 1e18-scaled
        calls.push({ target: pools.curve.address, allowFailure: true, callData: CURVE_POOL.encodeFunctionData('get_p', [0]) });
        decoders.push(['price_curve', data => {
            const p = Number(ethers.formatEther(CURVE_POOL.decodeFunctionResult('get_p', data)[0]));
            if (!p) return null;
            return pools.curve.boldIsCoin0 ? 1 / p : p;
        }]);
    }

    const out = { price_curve: null, price_uni_v3: null, price_uni_v4: null };
    const results = await multicall.aggregate3.staticCall(calls, { blockTag });
    results.forEach((r, i) => {
        const [key, decode] = decoders[i];
        if (r.success && r.returnData !== '0x') {
            try { out[key] = decode(r.returnData); } catch { /* pool not initialised at this block */ }
        }
    });
    return out;
}

// ETH/USDC price at the moment a tx executes. The pool's Swap events carry its price after each trade, so the
// last swap earlier in the same block gives the price the redemption met. Swaps by the redeeming bot itself
// (its EOA or contract as caller or recipient) are skipped: they are part of its own trade, not a market move.
// Returns null when nobody else traded the pool earlier in the block: the previous block's price is then exact.
async function ethPriceBeforeTx(receipt, caches) {
    const blockNumber = receipt.blockNumber;
    const swaps = await cached(caches.ethSwaps, blockNumber, () => withRetry(() => provider.getLogs({
        address: ETH_USDC_POOL, topics: [UNI_V3_SWAP_TOPIC], fromBlock: blockNumber, toBlock: blockNumber
    })));
    const bot = new Set([receipt.from.toLowerCase(), (receipt.to || '').toLowerCase()]);
    const party = topic => ethers.getAddress(ethers.dataSlice(topic, 12)).toLowerCase();
    const last = swaps
        .filter(l => l.transactionIndex < receipt.index && !bot.has(party(l.topics[1])) && !bot.has(party(l.topics[2])))
        .reduce((a, l) => (!a || l.index > a.index ? l : a), null);
    if (!last) return null;
    const sqrtPriceX96 = ethers.AbiCoder.defaultAbiCoder().decode(['int256', 'int256', 'uint160', 'uint128', 'int24'], last.data)[2];
    return 1e12 / (Number(sqrtPriceX96) / 2 ** 96) ** 2; // WETH per USDC in raw units, inverted to USD per ETH
}

// Flash-loan lenders used in the tx, e.g. "Morpho" or "Balancer,Morpho"; null when none is detected
function flashVenues(receipt) {
    const venues = new Set();
    for (const log of receipt.logs) {
        const known = FLASH_EVENTS[log.topics[0]];
        if (!known) continue;
        const venue = typeof known === 'string' ? known.slice(1) : known[log.address.toLowerCase()];
        if (venue) venues.add(venue);
    }
    const swap = flashSwapVenue(receipt);
    if (swap) venues.add(swap);
    return venues.size ? [...venues].sort().join(',') : null;
}

// Flash swap: the redeemer's first token movement is a pool paying it (the output of a swap not yet paid for),
// and that pool is paid back later in the tx, typically with the redeemed collateral. Pools of the known
// flash-loan lenders are left to their events.
function flashSwapVenue(receipt) {
    const redeemer = new Set([receipt.from.toLowerCase(), (receipt.to || '').toLowerCase()]);
    const moves = [];
    for (const log of receipt.logs) {
        if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
        const from = ethers.dataSlice(log.topics[1], 12).toLowerCase(), to = ethers.dataSlice(log.topics[2], 12).toLowerCase();
        if (from === ethers.ZeroAddress || to === ethers.ZeroAddress) continue;
        if (redeemer.has(to) && !redeemer.has(from)) moves.push({ dir: 'in', party: from });
        else if (redeemer.has(from) && !redeemer.has(to)) moves.push({ dir: 'out', party: to });
    }
    const first = moves[0];
    if (!first || first.dir !== 'in' || FLASH_LENDERS.has(first.party)) return null;
    if (!moves.slice(1).some(m => m.dir === 'out' && m.party === first.party)) return null;
    if (first.party === UNI_V4_POOL_MANAGER_ADDRESS) return 'Uniswap v4 flash swap';
    if (first.party === BALANCER_V3_VAULT) return 'Balancer v3 flash swap';
    const uniV3 = receipt.logs.some(l => l.address.toLowerCase() === first.party && l.topics[0] === UNI_V3_SWAP_TOPIC);
    return uniV3 ? 'Uniswap v3 flash swap' : 'Other flash swap';
}

// Where the redeemed BOLD came from within the tx. Each address is counted by its net BOLD outflow, so routers
// passing BOLD along and loans repaid within the tx cancel out. What was not sourced in the tx was already held.
function boldSources(receipt, amount) {
    const { pools } = config;
    const bold = env('BOLD_TOKEN_ADDRESS').toLowerCase();
    const redeemer = new Set([receipt.from.toLowerCase(), (receipt.to || '').toLowerCase()]);
    const net = new Map();
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== bold || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
        const from = ethers.dataSlice(log.topics[1], 12).toLowerCase(), to = ethers.dataSlice(log.topics[2], 12).toLowerCase();
        if (from === ethers.ZeroAddress || to === ethers.ZeroAddress) continue; // mint, or the redemption's burn
        const v = Number(ethers.formatEther(log.data));
        net.set(from, (net.get(from) || 0) + v);
        net.set(to, (net.get(to) || 0) - v);
    }
    const venue = {
        [pools.curve?.address.toLowerCase()]: 'curve', [pools.uniV3?.address.toLowerCase()]: 'uni_v3', [pools.uniV4?.address.toLowerCase()]: 'uni_v4'
    };
    const src = { curve: 0, uni_v3: 0, uni_v4: 0, other: 0 };
    for (const [addr, out] of net) if (out > 1e-9 && !redeemer.has(addr)) src[venue[addr] || 'other'] += out;
    // Scale down if the tx sourced more BOLD than it redeemed (the rest stayed with the redeemer)
    const sourced = src.curve + src.uni_v3 + src.uni_v4 + src.other;
    const k = sourced > amount ? amount / sourced : 1;
    return {
        bold_src_curve: src.curve * k, bold_src_uni_v3: src.uni_v3 * k, bold_src_uni_v4: src.uni_v4 * k, bold_src_other: src.other * k,
        bold_src_held: Math.max(amount - sourced * k, 0)
    };
}

function collMarketPrice(symbol, prices) {
    if (prices.eth_usd == null) return null;
    if (symbol === 'WETH') return prices.eth_usd;
    const rate = prices[`rate_${symbol}`];
    return rate == null ? null : prices.eth_usd * rate;
}

// Every redemption burns the redeemed BOLD, so redemption txs are found among BOLD burns
// (Transfers to the zero address). Alchemy's transfers API lists those over any block range,
// unlike eth_getLogs (10 blocks on the free tier); each burn's receipt then shows whether it
// carries TroveManager Redemption events.
async function boldBurnTxs(fromBlock, toBlock) {
    const txs = new Map(); // tx hash -> block number
    let pageKey;
    do {
        const res = await withRetry(() => provider.send('alchemy_getAssetTransfers', [{
            fromBlock: ethers.toQuantity(fromBlock),
            toBlock: ethers.toQuantity(toBlock),
            toAddress: ethers.ZeroAddress,
            contractAddresses: [env('BOLD_TOKEN_ADDRESS')],
            category: ['erc20'],
            maxCount: '0x3e8',
            ...(pageKey && { pageKey })
        }]));
        res.transfers.forEach(t => txs.set(t.hash, Number(t.blockNum)));
        pageKey = res.pageKey;
    } while (pageKey);
    return txs;
}

async function burnReceipt(hash, blockNumber) {
    try {
        return await withRetry(async () => {
            // Near the chain head another Alchemy node may not have the receipt yet
            const receipt = await provider.getTransactionReceipt(hash);
            if (!receipt) throw new Error(`receipt not available for ${hash}`);
            return receipt;
        }, 4);
    } catch (e) {
        // Alchemy's transfers index can keep entries from blocks that were later reorged out
        const block = await withRetry(() => provider.getBlock(blockNumber));
        if (block && !block.transactions.includes(hash)) {
            console.warn(`Skipping ${hash}: not in canonical block ${blockNumber} (reorged out)`);
            return null;
        }
        throw e;
    }
}

async function* scanRedemptions(fromBlock, toBlock) {
    const { branches } = config;
    for (let start = fromBlock; start <= toBlock; start += SCAN_CHUNK) {
        const end = Math.min(start + SCAN_CHUNK - 1, toBlock);
        const burns = await boldBurnTxs(start, end);
        const receipts = await mapPool([...burns], ENRICH_CONCURRENCY, ([hash, blockNumber]) => burnReceipt(hash, blockNumber));
        const txs = receipts
            .filter(Boolean)
            .map(receipt => ({
                receipt,
                logs: receipt.logs.filter(l => branches[l.address.toLowerCase()] && l.topics[0] === REDEMPTION_TOPIC)
            }))
            .filter(t => t.logs.length);
        yield { txs, toBlock: end };
    }
}

// ETH paid straight to the block's fee recipient (the builder) inside each tx, e.g. by a bot
// contract calling block.coinbase.transfer(). Needs Alchemy's transfers API; null if unavailable.
async function coinbaseTransfers(blockNumber, feeRecipient) {
    const tips = new Map();
    let pageKey;
    try {
        do {
            const res = await withRetry(() => provider.send('alchemy_getAssetTransfers', [{
                fromBlock: ethers.toQuantity(blockNumber),
                toBlock: ethers.toQuantity(blockNumber),
                toAddress: feeRecipient,
                category: ['external', 'internal'],
                excludeZeroValue: true,
                maxCount: '0x3e8',
                ...(pageKey && { pageKey })
            }]));
            for (const t of res.transfers) {
                const wei = t.rawContract?.value ? BigInt(t.rawContract.value) : ethers.parseEther(t.value.toFixed(18));
                tips.set(t.hash, (tips.get(t.hash) || 0n) + wei);
            }
            pageKey = res.pageKey;
        } while (pageKey);
    } catch (e) {
        console.warn(`Builder tips unavailable for block ${blockNumber}: ${e.shortMessage || e.message}`);
        return null;
    }
    return tips;
}

function cached(cache, key, fn) {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
}

// Troves touched by the redemptions in a receipt, in processing order (ascending interest rate per branch)
function redeemedTroves(receipt) {
    const { branches } = config;
    const num = v => Number(ethers.formatEther(v));
    const rows = [];
    const updates = new Map(); // latest TroveUpdated / BatchedTroveUpdated per trove
    for (const log of receipt.logs) {
        const branch = branches[log.address.toLowerCase()];
        if (!branch) continue;
        let ev;
        try { ev = TROVE_EVENTS.parseLog(log); } catch { continue; }
        if (!ev) continue;
        const a = ev.args;
        const key = ev.name === 'BatchUpdated' ? null : `${log.address}:${a._troveId}`;
        if (ev.name === 'TroveUpdated') {
            updates.set(key, { debt_after: num(a._debt), coll_after: num(a._coll), batch_manager: null });
        } else if (ev.name === 'BatchedTroveUpdated') {
            // A batched trove's debt is held as shares of the batch; resolved at the following BatchUpdated
            updates.set(key, { shares: a._batchDebtShares, coll_after: num(a._coll), batch_manager: a._interestBatchManager.toLowerCase() });
        } else if (ev.name === 'TroveOperation' && a._operation === OP_REDEEM_COLLATERAL) {
            const u = updates.get(key) || {};
            rows.push({
                tx_hash: receipt.hash,
                log_index: log.index,
                branch: branch.symbol,
                trove_id: ethers.toBeHex(a._troveId, 32),
                interest_rate: num(a._annualInterestRate) * 100,
                debt_redeemed: -num(a._debtChangeFromOperation),
                coll_redeemed: -num(a._collChangeFromOperation),
                fee_coll: null,
                debt_after: u.debt_after ?? null,
                coll_after: u.coll_after ?? null,
                batch_manager: u.batch_manager ?? null,
                _key: key,
                _shares: u.shares
            });
        } else if (ev.name === 'BatchUpdated') {
            const row = rows.findLast(r => r.batch_manager === a._interestBatchManager.toLowerCase() && r._shares != null && r.debt_after == null);
            if (row) {
                row.debt_after = a._totalDebtShares > 0n ? num(row._shares * a._debt / a._totalDebtShares) : 0;
                row.interest_rate = num(a._annualInterestRate) * 100;
            }
        } else if (ev.name === 'RedemptionFeePaidToTrove') {
            const row = rows.findLast(r => r._key === key && r.fee_coll == null);
            if (row) row.fee_coll = num(a._ETHFee);
        }
    }
    return rows.map(({ _key, _shares, ...row }) => row);
}

async function enrichTx(receipt, logs, caches) {
    const { branches, registryAddress } = config;
    const txHash = receipt.hash;
    const blockNumber = receipt.blockNumber;
    const [block, prices, ethNow] = await Promise.all([
        cached(caches.blocks, blockNumber, () => withRetry(() => provider.getBlock(blockNumber))),
        withRetry(() => pricesAt(blockNumber - 1)),
        ethPriceBeforeTx(receipt, caches)
    ]);
    // BOLD prices stay at the previous block (moves within the block are mostly the redeemer's own purchase);
    // ETH, and through it the collateral, is priced at the moment of the redemption
    if (ethNow != null) prices.eth_usd = ethNow;
    const tips = await cached(caches.tips, blockNumber, () => coinbaseTransfers(blockNumber, block.miner));

    const events = logs.map(log => {
        const a = TROVE_MANAGER.parseLog(log).args;
        const num = v => Number(ethers.formatEther(v));
        const branch = branches[log.address.toLowerCase()].symbol;
        return {
            tx_hash: txHash,
            log_index: log.index,
            branch,
            bold_attempted: num(a._attemptedBoldAmount),
            bold_redeemed: num(a._actualBoldAmount),
            coll_sent: num(a._ETHSent),
            coll_fee: num(a._ETHFee),
            coll_price: num(a._price),
            redemption_price: num(a._redemptionPrice),
            coll_market_price: collMarketPrice(branch, prices)
        };
    });

    const amount = events.reduce((s, e) => s + e.bold_redeemed, 0);
    // Redeemers profit from BOLD trading below $1 and from the oracle lagging the market,
    // so the collateral is valued at its market price (oracle price when unavailable)
    const collValue = events.reduce((s, e) => s + e.coll_sent * (e.coll_market_price ?? e.coll_price), 0);
    const feeUsd = events.reduce((s, e) => s + e.coll_fee * e.redemption_price, 0);
    const gapEvents = events.filter(e => e.coll_market_price != null && e.bold_redeemed);
    const gapWeight = gapEvents.reduce((s, e) => s + e.bold_redeemed, 0);
    const oracleGap = gapWeight
        ? gapEvents.reduce((s, e) => s + (e.coll_market_price / e.redemption_price - 1) * 100 * e.bold_redeemed, 0) / gapWeight
        : null;
    const market = prices.price_curve ?? prices.price_uni_v3 ?? prices.price_uni_v4;
    const to = (receipt.to || '').toLowerCase();
    // Dust redemptions (a few wei) round the collateral down to 0, so ratios are meaningless
    const priced = amount >= 1;

    // Inclusion costs: base fee is burned; priority fee and coinbase transfers go to the builder
    const eth = wei => wei == null ? null : Number(ethers.formatEther(wei));
    const usd = v => v == null || prices.eth_usd == null ? null : v * prices.eth_usd;
    const baseFeeWei = receipt.gasUsed * block.baseFeePerGas;
    const priorityFeeWei = receipt.gasUsed * receipt.gasPrice - baseFeeWei;
    const coinbaseTipWei = tips ? (tips.get(txHash) ?? 0n) : null;
    const gasFeeUsd = usd(eth(baseFeeWei));
    const builderTipUsd = coinbaseTipWei == null ? null : usd(eth(priorityFeeWei + coinbaseTipWei));
    const purchaseCost = market != null && priced ? amount * market : null;
    const grossProfit = purchaseCost != null ? collValue - purchaseCost : null;
    const netProfit = grossProfit != null && gasFeeUsd != null && builderTipUsd != null
        ? grossProfit - gasFeeUsd - builderTipUsd
        : null;

    return {
        events,
        troves: redeemedTroves(receipt),
        redemption: {
            tx_hash: txHash,
            block: blockNumber,
            timestamp: block.timestamp * 1000,
            sender: receipt.from.toLowerCase(),
            to_address: to,
            // Direct calls go to the CollateralRegistry (or a TroveManager for urgent redemptions)
            via_contract: to !== registryAddress && !branches[to] ? 1 : 0,
            branches: [...new Set(events.map(e => e.branch))].join(','),
            amount,
            coll_value_usd: collValue,
            fee_usd: feeUsd,
            price_curve: prices.price_curve,
            price_uni_v3: prices.price_uni_v3,
            price_uni_v4: prices.price_uni_v4,
            market_price: market,
            spread: market != null ? (1 - market) * 100 : null,
            oracle_gap: oracleGap,
            fee_pct: priced ? feeUsd / amount * 100 : null,
            net_edge: purchaseCost != null ? (collValue / purchaseCost - 1) * 100 : null,
            gas_used: Number(receipt.gasUsed),
            base_fee_eth: eth(baseFeeWei),
            priority_fee_eth: eth(priorityFeeWei),
            coinbase_tip_eth: eth(coinbaseTipWei),
            eth_usd: prices.eth_usd,
            gross_profit_usd: grossProfit,
            gas_fee_usd: gasFeeUsd,
            builder_tip_usd: builderTipUsd,
            net_profit_usd: netProfit,
            net_margin: netProfit != null ? netProfit / purchaseCost * 100 : null,
            flash_venue: flashVenues(receipt),
            ...boldSources(receipt, amount)
        }
    };
}

async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    }));
    return results;
}

const saveChunk = db.transaction((rows, toBlock) => {
    for (const { events, troves, redemption } of rows) {
        events.forEach(e => insertEvent.run(e));
        troves.forEach(t => insertTrove.run(t));
        insertRedemption.run(redemption);
    }
    setState.run('last_block', String(toBlock));
});

const saveTroves = db.transaction(rows => rows.forEach(t => insertTrove.run(t)));

// Redeemer addresses: deployers of the contracts redeemers call (Etherscan) and ENS names, looked up once per
// address (ENS rechecked monthly). Failures are logged and retried at the next sync; they never fail the sync.
const ENS_RECHECK_MS = 30 * 864e5;
const newAddresses = db.prepare(`INSERT OR IGNORE INTO addresses (address, is_contract)
    SELECT sender, 0 FROM redemptions UNION SELECT to_address, 1 FROM redemptions WHERE via_contract = 1`);
const contractsWithoutDeployer = db.prepare('SELECT address FROM addresses WHERE is_contract = 1 AND deployer_checked_at IS NULL');
const setDeployer = db.prepare('UPDATE addresses SET deployer = ?, created_tx = ?, deployer_checked_at = ? WHERE address = ?');
const addressesForEns = db.prepare('SELECT address FROM addresses WHERE ens_checked_at IS NULL OR ens_checked_at < ?');
const setEns = db.prepare('UPDATE addresses SET ens = ?, ens_checked_at = ? WHERE address = ?');

async function refreshAddresses() {
    newAddresses.run();
    const key = process.env.ETHERSCAN_API_KEY;
    const pending = contractsWithoutDeployer.all().map(r => r.address);
    if (key && pending.length) {
        state.phase = 'looking up contract deployers';
        // Etherscan answers up to 5 contracts per request; the free tier allows a few requests per second
        for (let i = 0; i < pending.length; i += 5) {
            const chunk = pending.slice(i, i + 5);
            try {
                const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getcontractcreation&contractaddresses=${chunk.join(',')}&apikey=${key}`;
                const res = await withRetry(async () => {
                    const r = await fetch(url).then(x => x.json());
                    if (r.status !== '1' && !/no data/i.test(r.message || '') && !/no data/i.test(String(r.result))) throw new Error(`Etherscan: ${r.result || r.message}`);
                    return r;
                }, 4);
                const found = new Map((Array.isArray(res.result) ? res.result : []).map(c => [c.contractAddress.toLowerCase(), c]));
                for (const a of chunk) {
                    const c = found.get(a);
                    setDeployer.run(c ? c.contractCreator.toLowerCase() : null, c ? c.txHash : null, Date.now(), a);
                }
            } catch (e) {
                console.warn(`Deployer lookup failed (${chunk.length} contracts): ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 300));
        }
    }
    const ensDue = addressesForEns.all(Date.now() - ENS_RECHECK_MS).map(r => r.address);
    if (ensDue.length) state.phase = 'looking up ENS names';
    await mapPool(ensDue, ENRICH_CONCURRENCY, async a => {
        try {
            // lookupAddress returns the primary name only if it also resolves back to the address
            const name = await withRetry(() => provider.lookupAddress(a), 4);
            setEns.run(name || null, Date.now(), a);
        } catch (e) {
            // A resolver that reverts has no usable name: record that rather than retrying at every sync
            if (e.code === 'CALL_EXCEPTION') setEns.run(null, Date.now(), a);
            else console.warn(`ENS lookup failed for ${a}: ${e.shortMessage || e.message}`);
        }
    });
}

// Redemptions synced before trove decoding was added have no trove rows yet: decode them from
// their receipts once. Runs until every redemption has its troves, then is skipped.
async function backfillTroves() {
    if (getState.get('troves_backfilled')?.value === '1') return;
    const hashes = txsWithoutTroves.all().map(r => r.tx_hash);
    if (hashes.length) console.log(`Backfilling trove details for ${hashes.length} redemption tx…`);
    for (let i = 0; i < hashes.length; i += 100) {
        const chunk = hashes.slice(i, i + 100);
        const rows = await mapPool(chunk, ENRICH_CONCURRENCY, hash => withRetry(async () => {
            const receipt = await provider.getTransactionReceipt(hash);
            if (!receipt) throw new Error(`receipt not available for ${hash}`);
            return redeemedTroves(receipt);
        }));
        saveTroves(rows.flat());
        state.phase = `backfilling troves ${Math.min(i + chunk.length, hashes.length)}/${hashes.length}`;
    }
    setState.run('troves_backfilled', '1');
}

async function syncData() {
    if (state.running) return getStatus();
    Object.assign(state, { running: true, phase: 'starting', found: 0, processed: 0, startedAt: Date.now(), lastError: null });

    try {
        if (!process.env.RPC_URL && !process.env.ALCHEMY_API_KEY) throw new Error('ALCHEMY_API_KEY is not set');
        await loadConfig();
        if (getState.get('scan_version')?.value !== SCAN_VERSION) {
            // Start over from the V2 launch; existing rows are refreshed in place
            setState.run('last_block', String(START_BLOCK - 1));
            setState.run('scan_version', SCAN_VERSION);
        }
        const head = await withRetry(() => provider.getBlockNumber());
        const target = head - CONFIRMATIONS;
        const from = (lastSyncedBlock() ?? START_BLOCK - 1) + 1;
        Object.assign(state, { phase: 'scanning', fromBlock: from, targetBlock: target, scannedTo: from - 1 });
        console.log(`Sync: blocks ${from} → ${target} across ${Object.keys(config.branches).length} branches (${Object.values(config.branches).map(b => b.symbol).join(', ')})`);

        const caches = { blocks: new Map(), tips: new Map(), ethSwaps: new Map() };
        for await (const { txs, toBlock } of scanRedemptions(from, target)) {
            state.found += txs.length;
            const rows = await mapPool(txs, ENRICH_CONCURRENCY, async ({ receipt, logs }) => {
                const row = await enrichTx(receipt, logs, caches);
                state.processed++;
                return row;
            });
            saveChunk(rows, toBlock);
            state.scannedTo = toBlock;
            if (txs.length) console.log(`  …block ${toBlock}: ${txs.length} redemption tx`);
        }

        await backfillTroves();
        try {
            await refreshAddresses();
        } catch (e) {
            console.warn(`Address details not refreshed: ${e.message}`);
        }
        console.log(`Sync complete: ${state.processed} redemption tx processed, synced to block ${target}.`);
    } catch (e) {
        state.lastError = e.shortMessage || e.message;
        console.error('Sync failed:', state.lastError);
        throw e;
    } finally {
        Object.assign(state, { running: false, phase: 'idle', finishedAt: Date.now() });
    }
    return getStatus();
}

function getStatus() {
    return { ...state, lastSyncedBlock: lastSyncedBlock() };
}

// flashVenues, boldSources and loadConfig are exposed for checks against individual transactions
module.exports = { syncData, getStatus, flashVenues, boldSources, loadConfig };

if (require.main === module) {
    syncData()
        .then(() => db.close())
        .catch(() => process.exit(1));
}
