// ETH's exchange price at each redemption, the market reference for the oracle gap: the average of Coinbase (ETH-USD) and
// Bitstamp (ETH/USD) at the redemption's block time, each interpolated between the open and the close of that minute's candle.
// Both are public endpoints without an API key. One exchange is used when the other has no candle near that minute; a redemption
// that neither covers keeps an empty value and is tried again at the next sync. Called by worker.js after the measured results;
// a failure here leaves every other figure untouched (the page then falls back to the Uniswap reference).
const db = require('./db');

const MAX_GAP = 180;                        // a candle up to 3 minutes earlier stands in for a minute without trades (its close)
const SOURCES = [
    {
        name: 'Coinbase', perRequest: 300, pause: 250,
        // [time, low, high, open, close, volume], newest first
        url: (from, to) => `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60`
            + `&start=${new Date(from * 1000).toISOString()}&end=${new Date(to * 1000).toISOString()}`,
        candles: body => Array.isArray(body) ? body.map(c => [c[0], c[3], c[4]]) : null
    },
    {
        name: 'Bitstamp', perRequest: 1000, pause: 250,
        url: (from, to) => `https://www.bitstamp.net/api/v2/ohlc/ethusd/?step=60&limit=1000&start=${from}&end=${to}`,
        candles: body => Array.isArray(body?.data?.ohlc) ? body.data.ohlc.map(c => [Number(c.timestamp), Number(c.open), Number(c.close)]) : null
    }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const minuteOf = t => t - (t % 60);

async function getJson(url) {
    for (let i = 0; ; i++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'bold-redemption-dashboard', Accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return null;                                         // a refused request is not retried
            return await res.json();
        } catch (e) {
            if (i >= 4) return null;
            await sleep(1000 * 2 ** i);
        }
    }
}

// Candles of one exchange covering the given minutes, as minute -> [open, close]; fetched in windows of perRequest minutes
async function candlesFor(source, minutes) {
    const out = new Map();
    const sorted = [...new Set(minutes)].sort((a, b) => a - b);
    let failed = 0;
    for (let i = 0; i < sorted.length;) {
        const from = sorted[i] - MAX_GAP, to = from + (source.perRequest - 1) * 60;
        const body = await getJson(source.url(from, to));
        const list = body && source.candles(body);
        if (list) for (const [t, open, close] of list) if (Number.isFinite(open) && Number.isFinite(close)) out.set(t, [open, close]);
        else failed++;
        while (i < sorted.length && sorted[i] <= to) i++;
        await sleep(source.pause);
    }
    return { candles: out, failed };
}

// The exchange's price at time t: interpolated within t's minute, or the last close up to MAX_GAP earlier
function priceAt(candles, t) {
    const m = minuteOf(t), c = candles.get(m);
    if (c) return c[0] + (c[1] - c[0]) * ((t - m) / 60);
    for (let k = m - 60; k >= m - MAX_GAP; k -= 60) if (candles.has(k)) return candles.get(k)[1];
    return null;
}

const missing = db.prepare('SELECT tx_hash, timestamp FROM redemptions WHERE cex_eth_usd IS NULL ORDER BY timestamp');
const setPrice = db.prepare('UPDATE redemptions SET cex_eth_usd = ? WHERE tx_hash = ?');
const save = db.transaction(rows => rows.forEach(([tx, v]) => setPrice.run(v, tx)));

async function fillExchangePrices() {
    const rows = missing.all();
    if (!rows.length) return { filled: 0, left: 0 };
    const times = rows.map(r => Math.floor(r.timestamp / 1000));
    const bySource = [];
    for (const s of SOURCES) bySource.push({ s, ...(await candlesFor(s, times.map(minuteOf))) });
    const updates = [];
    let spreadWarnings = 0;
    rows.forEach((r, k) => {
        const prices = bySource.map(b => priceAt(b.candles, times[k])).filter(v => v != null);
        if (!prices.length) return;
        if (prices.length === 2 && Math.abs(prices[0] / prices[1] - 1) > 0.02) spreadWarnings++;
        updates.push([r.tx_hash, prices.reduce((a, b) => a + b, 0) / prices.length]);
    });
    save(updates);
    if (spreadWarnings) console.warn(`Exchange prices: Coinbase and Bitstamp differ by more than 2% for ${spreadWarnings} redemptions`);
    return { filled: updates.length, left: rows.length - updates.length,
        failedRequests: Object.fromEntries(bySource.map(b => [b.s.name, b.failed])) };
}

module.exports = { fillExchangePrices, priceAt, minuteOf };
