const express = require('express');
const cors = require('cors');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const queries = require('./queries');
const { syncData, getStatus } = require('./worker');

const SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 5);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/redemptions', (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 5000, 50000);
        res.json(queries.redemptions(limit));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/bots', (req, res) => {
    try {
        res.json(queries.bots());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        res.json(queries.stats());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

function startSync() {
    if (getStatus().running) return false;
    syncData().catch(() => { /* logged and exposed via /api/status */ });
    return true;
}

app.post('/api/sync', (req, res) => {
    const started = startSync();
    res.status(started ? 202 : 200).json({ started, status: getStatus() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    startSync();
    setInterval(startSync, SYNC_INTERVAL_MINUTES * 60 * 1000);
});
