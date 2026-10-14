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
const MIN_LOG_SPAN = 1000;
const MAX_LOG_SPAN = 100000;
const ENRICH_CONCURRENCY = 4;

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
// Uniswap v3 USDC/WETH 0.05%, the reference ETH market price
const ETH_USDC_POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
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

// Main RPC: Alchemy (key or full URL). Used for everything except the log scan.
function mainRpcUrl() {
    const k = (process.env.RPC_URL || process.env.ALCHEMY_API_KEY || '').trim();
    if (!k) return 'https://ethereum-rpc.publicnode.com';
    return k.startsWith('http') ? k : `https://eth-mainnet.g.alchemy.com/v2/${k}`;
}

// Alchemy's free tier caps eth_getLogs at 10 blocks, so the log scan goes to
// public RPCs that allow wide ranges, rotating between them on failure.
const LOGS_RPC_URLS = (process.env.LOGS_RPC_URLS || 'https://rpc.flashbots.net,https://ethereum-rpc.publicnode.com')
    .split(',').map(s => s.trim()).filter(Boolean);

const provider = makeProvider(mainRpcUrl());
const logProviders = LOGS_RPC_URLS.map(makeProvider);
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
     gross_profit_usd, gas_fee_usd, builder_tip_usd, net_profit_usd, net_margin)
    VALUES (@tx_hash, @block, @timestamp, @sender, @to_address, @via_contract, @branches, @amount, @coll_value_usd, @fee_usd,
     @price_curve, @price_uni_v3, @price_uni_v4, @market_price, @spread, @oracle_gap, @fee_pct, @net_edge,
     @gas_used, @base_fee_eth, @priority_fee_eth, @coinbase_tip_eth, @eth_usd,
     @gross_profit_usd, @gas_fee_usd, @builder_tip_usd, @net_profit_usd, @net_margin)`);

function lastSyncedBlock() {
    const row = getState.get('last_block');
    return row ? Number(row.value) : null;
}

async function withRetry(fn, attempts = 5) {
    for (let i = 0; ; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i >= attempts - 1) throw e;
            await new Promise(r => setTimeout(r, 500 * 2 ** i));
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

function collMarketPrice(symbol, prices) {
    if (prices.eth_usd == null) return null;
    if (symbol === 'WETH') return prices.eth_usd;
    const rate = prices[`rate_${symbol}`];
    return rate == null ? null : prices.eth_usd * rate;
}

async function* scanLogs(addresses, fromBlock, toBlock) {
    let span = 20000;
    let rpc = 0;
    let failures = 0;
    while (fromBlock <= toBlock) {
        const end = Math.min(fromBlock + span - 1, toBlock);
        try {
            const logs = await logProviders[rpc].getLogs({ address: addresses, topics: [REDEMPTION_TOPIC], fromBlock, toBlock: end });
            yield { logs, toBlock: end };
            fromBlock = end + 1;
            failures = 0;
            span = Math.min(span * 2, MAX_LOG_SPAN);
        } catch (e) {
            if (++failures > 20) throw new Error(`eth_getLogs keeps failing (${LOGS_RPC_URLS[rpc]}): ${e.shortMessage || e.message}`);
            if (span > MIN_LOG_SPAN) span = Math.max(Math.floor(span / 2), MIN_LOG_SPAN);
            else rpc = (rpc + 1) % logProviders.length;
        }
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

async function enrichTx(txHash, blockNumber, logs, caches) {
    const { branches, registryAddress } = config;
    const [tx, receipt, block, prices] = await Promise.all([
        withRetry(() => provider.getTransaction(txHash)),
        withRetry(() => provider.getTransactionReceipt(txHash)),
        cached(caches.blocks, blockNumber, () => withRetry(() => provider.getBlock(blockNumber))),
        withRetry(() => pricesAt(blockNumber - 1))
    ]);
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
    const to = (tx.to || '').toLowerCase();
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
        redemption: {
            tx_hash: txHash,
            block: blockNumber,
            timestamp: block.timestamp * 1000,
            sender: tx.from.toLowerCase(),
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
            net_margin: netProfit != null ? netProfit / purchaseCost * 100 : null
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
    for (const { events, redemption } of rows) {
        events.forEach(e => insertEvent.run(e));
        insertRedemption.run(redemption);
    }
    setState.run('last_block', String(toBlock));
});

async function syncData() {
    if (state.running) return getStatus();
    Object.assign(state, { running: true, phase: 'starting', found: 0, processed: 0, startedAt: Date.now(), lastError: null });

    try {
        await loadConfig();
        const head = await withRetry(() => provider.getBlockNumber());
        const target = head - CONFIRMATIONS;
        const from = (lastSyncedBlock() ?? START_BLOCK - 1) + 1;
        Object.assign(state, { phase: 'scanning', fromBlock: from, targetBlock: target, scannedTo: from - 1 });
        console.log(`Sync: blocks ${from} → ${target} across ${Object.keys(config.branches).length} branches (${Object.values(config.branches).map(b => b.symbol).join(', ')})`);

        const caches = { blocks: new Map(), tips: new Map() };
        for await (const { logs, toBlock } of scanLogs(Object.keys(config.branches), from, target)) {
            const byTx = new Map();
            for (const log of logs) {
                if (!byTx.has(log.transactionHash)) byTx.set(log.transactionHash, { block: log.blockNumber, logs: [] });
                byTx.get(log.transactionHash).logs.push(log);
            }
            state.found += byTx.size;

            const rows = await mapPool([...byTx], ENRICH_CONCURRENCY, async ([hash, { block, logs }]) => {
                const row = await enrichTx(hash, block, logs, caches);
                state.processed++;
                return row;
            });
            saveChunk(rows, toBlock);
            state.scannedTo = toBlock;
            if (byTx.size) console.log(`  …block ${toBlock}: +${byTx.size} redemption tx`);
        }

        console.log(`Sync complete: ${state.processed} new redemption tx, synced to block ${target}.`);
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

module.exports = { syncData, getStatus };

if (require.main === module) {
    syncData()
        .then(() => db.close())
        .catch(() => process.exit(1));
}
