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
    eth_usd REAL,                    -- ETH/USDC in the block before
    gross_profit_usd REAL,           -- collateral at market price - BOLD bought at market_price
    gas_fee_usd REAL,                -- base fee in USD
    builder_tip_usd REAL,            -- priority fee + coinbase tip in USD
    net_profit_usd REAL,             -- gross profit - gas fee - builder tip
    net_margin REAL                  -- net profit, in % of the BOLD purchase cost
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
    coll_market_price REAL,          -- ETH/USDC on Uniswap v3 x the LST's exchange rate, in the block before
    PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);
