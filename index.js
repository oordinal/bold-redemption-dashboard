const express = require('express');
const cors = require('cors');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const queries = require('./queries');
const { syncData, getStatus } = require('./worker');
const { snapshotTroves } = require('./troves');
const { syncTroveOps, troveOpsExport } = require('./troveops');

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

app.get('/api/addresses', (req, res) => {
    try {
        res.json(queries.addresses());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/batches', (req, res) => {
    try {
        res.json(queries.batchRows());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/troves', (req, res) => {
    try {
        const snapshot = queries.troves();
        if (!snapshot) return res.status(404).json({ error: 'no trove snapshot yet' });
        res.json(snapshot);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/troveops', (req, res) => {
    try {
        const data = troveOpsExport();
        if (!data) return res.status(404).json({ error: 'no trove snapshot yet' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/trovehits', (req, res) => {
    try {
        res.json(queries.troveHits());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tx/:hash', (req, res) => {
    const hash = req.params.hash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ error: 'invalid transaction hash' });
    try {
        const detail = queries.txDetail(hash);
        if (!detail.events.length) return res.status(404).json({ error: 'not a recorded redemption' });
        res.json(detail);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

function startSync() {
    if (getStatus().running) return false;
    syncData()
        .catch(() => { /* logged and exposed via /api/status */ })
        // Troves tab: refreshed after every sync attempt; a failure keeps the previous snapshot
        .then(() => snapshotTroves())
        .catch(e => console.warn(`Trove snapshot not updated: ${e.shortMessage || e.message}`))
        // Borrowing record: a failure keeps the operations already stored
        .then(() => syncTroveOps())
        .catch(e => console.warn(`Trove operations not updated: ${e.message}`));
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
