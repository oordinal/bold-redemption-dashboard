-- One row per redemption transaction (all collateral branches aggregated)
CREATE TABLE IF NOT EXISTS redemptions (
    tx_hash TEXT PRIMARY KEY,
    block INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,      -- ms since epoch
    sender TEXT NOT NULL,            -- tx.from, the EOA that sent the transaction
    to_address TEXT,                 -- tx.to: the CollateralRegistry, or the contract that called it
    via_contract BOOLEAN NOT NULL,   -- redeemed through an intermediary contract (typical of arb bots)
    branches TEXT NOT NULL,          -- collateral branches hit, e.g. "WETH,wstETH"
    amount REAL NOT NULL,            -- BOLD redeemed
    coll_value_usd REAL NOT NULL,    -- collateral received, valued at the market price (oracle price if unavailable)
    fee_usd REAL NOT NULL,           -- redemption fee left in troves, valued at the redemption price
    price_curve REAL,                -- BOLD/USDC mid prices in the block before the redemption
    price_uni_v3 REAL,
    price_uni_v4 REAL,
    market_price REAL,               -- reference price: Curve, falling back to Uniswap v3, then v4
    spread REAL,                     -- BOLD discount to $1 at market_price, in %
    oracle_gap REAL,                 -- % the collateral's market price sits above Liquity's redemption price
    fee_pct REAL,                    -- redemption fee, in % of BOLD redeemed
    net_edge REAL,                   -- % gained buying BOLD at market_price and redeeming it (before gas)
    gas_used INTEGER,
    base_fee_eth REAL,               -- gas_used x block base fee (burned)
    priority_fee_eth REAL,           -- gas_used x priority fee, paid to the block builder
    coinbase_tip_eth REAL,           -- ETH sent straight to the block builder from inside the tx
    eth_usd REAL,                    -- ETH/USDC on Uniswap v3 at the moment of the redemption (last swap earlier in the block)
    gross_profit_usd REAL,           -- collateral at market price - BOLD bought at market_price
    gas_fee_usd REAL,                -- base fee in USD
    builder_tip_usd REAL,            -- priority fee + coinbase tip in USD
    net_profit_usd REAL,             -- gross profit - gas fee - builder tip
    net_margin REAL,                 -- net profit, in % of the BOLD purchase cost
    flash_venue TEXT,                -- flash-loan lenders detected in the tx, e.g. "Morpho" or "Morpho,Balancer"; NULL if none
    bold_src_curve REAL,             -- BOLD redeemed sourced in the tx from the Curve BOLD/USDC pool (net outflow)
    bold_src_uni_v3 REAL,            -- ... from the Uniswap v3 BOLD/USDC pool
    bold_src_uni_v4 REAL,            -- ... from Uniswap v4 (PoolManager, any BOLD pool)
    bold_src_other REAL,             -- ... from any other address: other pools and DEXs, lending markets
    bold_src_held REAL               -- BOLD not sourced in the tx: already held by the redeemer
);
CREATE INDEX IF NOT EXISTS idx_redemptions_block ON redemptions(block);
CREATE INDEX IF NOT EXISTS idx_redemptions_sender ON redemptions(sender);

-- Raw TroveManager Redemption events, one per branch hit
CREATE TABLE IF NOT EXISTS redemption_events (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    branch TEXT NOT NULL,
    bold_attempted REAL NOT NULL,
    bold_redeemed REAL NOT NULL,
    coll_sent REAL NOT NULL,
    coll_fee REAL NOT NULL,
    coll_price REAL NOT NULL,        -- Liquity oracle price
    redemption_price REAL NOT NULL,  -- price used to size the collateral lot
    coll_market_price REAL,          -- ETH/USDC on Uniswap v3 at the moment of the redemption x the LST's exchange rate
    PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Troves touched by each redemption, in processing order (decoded from the TroveManager logs)
CREATE TABLE IF NOT EXISTS redemption_troves (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,      -- index of the TroveOperation log, i.e. processing order
    branch TEXT NOT NULL,
    trove_id TEXT NOT NULL,          -- uint256 trove ID as 0x-prefixed hex
    interest_rate REAL,              -- annual interest rate, in %
    debt_redeemed REAL NOT NULL,     -- BOLD debt cancelled
    coll_redeemed REAL NOT NULL,     -- collateral sent to the redeemer
    fee_coll REAL,                   -- redemption fee left in the trove, in collateral
    debt_after REAL,                 -- remaining debt (derived from batch shares for batched troves)
    coll_after REAL,
    batch_manager TEXT,              -- interest batch manager, if the trove is in a batch
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_redemption_troves_tx ON redemption_troves(tx_hash);

-- Redeemer addresses (senders and the contracts they call): who deployed each contract and any ENS name.
-- Filled once per address after a sync; used to group senders and contracts into operators.
CREATE TABLE IF NOT EXISTS addresses (
    address TEXT PRIMARY KEY,
    is_contract BOOLEAN NOT NULL,    -- 1 for a contract redeemers call, 0 for a sender
    deployer TEXT,                   -- account that created the contract (Etherscan), NULL if unknown or a sender
    created_tx TEXT,                 -- creation transaction
    ens TEXT,                        -- primary ENS name, verified forward and back; NULL if none
    deployer_checked_at INTEGER,     -- ms since epoch of the last deployer lookup (NULL: not yet)
    ens_checked_at INTEGER           -- ms since epoch of the last ENS lookup
);

-- Latest snapshot of every open trove (troves.js), for the Troves tab: one JSON document, replaced after each sync
CREATE TABLE IF NOT EXISTS trove_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    taken_at INTEGER NOT NULL,       -- ms since epoch
    block INTEGER NOT NULL,          -- block the snapshot was read at
    data TEXT NOT NULL               -- JSON: branches, batch managers, troves (see troves.js)
);

-- Trove operations other than redemptions (troveops.js), from each TroveManager's TroveOperation events: opening, borrowing
-- and repaying, collateral changes, closing, rate and batch changes, liquidations. Redemptions are in redemption_troves.
CREATE TABLE IF NOT EXISTS trove_ops (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,      -- ms since epoch
    branch TEXT NOT NULL,            -- collateral symbol, as in redemption_troves
    trove_id TEXT NOT NULL,          -- uint256 trove ID as 0x-prefixed 32-byte hex
    operation TEXT NOT NULL,         -- openTrove, adjustTrove, closeTrove, adjustTroveInterestRate, liquidate, …
    interest_rate REAL,              -- annual interest rate after the operation, in %
    debt_change REAL NOT NULL,       -- BOLD borrowed (+) or repaid (−) by the operation, upfront fee not included
    upfront_fee REAL NOT NULL,       -- BOLD added to the debt as upfront fee
    coll_change REAL NOT NULL,       -- collateral added (+) or withdrawn (−)
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_trove_ops_trove ON trove_ops(branch, trove_id);
