// Syncs new redemptions, then writes the dashboard data as static JSON for hosting
// without a server (GitHub Actions publishes it to the `data` branch; see README).
//   node export.js [outDir]
const fs = require('fs');
const path = require('path');

const db = require('./db');
const queries = require('./queries');
const { syncData, getStatus } = require('./worker');
const { snapshotTroves } = require('./troves');
const { syncTroveOps, troveOpsExport } = require('./troveops');
const { runAlerts, runDigests, weekVolumes } = require('./alerts');

const outDir = path.resolve(process.argv[2] || 'out');

async function main() {
    await syncData();
    // Troves tab: a failed snapshot keeps the previous one (and never affects the redemption data)
    try {
        await snapshotTroves();
    } catch (e) {
        console.warn(`Trove snapshot not updated: ${e.shortMessage || e.message}`);
    }
    // Borrowing record of each trove (Etherscan): a failure keeps the operations already stored
    try {
        const r = await syncTroveOps();
        console.log(`Trove operations: ${JSON.stringify(r)}`);
    } catch (e) {
        console.warn(`Trove operations not updated: ${e.message}`);
    }
    // Telegram alerts for the watched troves (does nothing without the Upstash and Telegram settings; never stops the export)
    try {
        const r = await runAlerts();
        console.log(`Telegram alerts: ${JSON.stringify(r)}`);
    } catch (e) {
        console.warn(`Telegram alerts not sent: ${e.message}`);
    }
    // Telegram summaries (/digest), due at 08:00 UTC; the same conditions as the alerts
    try {
        const r = await runDigests();
        console.log(`Telegram summaries: ${JSON.stringify(r)}`);
    } catch (e) {
        console.warn(`Telegram summaries not sent: ${e.message}`);
    }

    fs.mkdirSync(outDir, { recursive: true });
    const write = (name, data) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(data));
    const { lastSyncedBlock, finishedAt } = getStatus();
    write('redemptions.json', queries.redemptions(50000));
    write('bots.json', queries.bots());
    write('stats.json', queries.stats());
    write('batches.json', queries.batchRows());
    write('addresses.json', queries.addresses());
    const troves = queries.troves();
    if (troves) {
        // the typical and busiest week of redemptions at the snapshot, so the bot's /status and /safe use the alerts' figures
        const w = weekVolumes(troves.ts * 1000);
        troves.weeks = { typical: w.weekVol, busiest: w.maxWeek };
        write('troves.json', troves);
    }
    write('trovehits.json', queries.troveHits());
    const ops = troveOpsExport();
    if (ops) write('troveops.json', ops);
    write('status.json', { running: false, lastSyncedBlock, generatedAt: finishedAt, lastError: null });
    // One file per redemption transaction, loaded by the page when a feed row is expanded
    fs.mkdirSync(path.join(outDir, 'tx'), { recursive: true });
    const details = queries.allTxDetails();
    for (const [hash, detail] of details) write(path.join('tx', `${hash}.json`), detail);

    // Fold the WAL into the main file so database.sqlite alone carries the full state
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    fs.copyFileSync(path.join(__dirname, 'database.sqlite'), path.join(outDir, 'database.sqlite'));
    console.log(`Exported to ${outDir} (block ${lastSyncedBlock}, ${details.length} transaction files)`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
