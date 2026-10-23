// Syncs new redemptions, then writes the dashboard data as static JSON for hosting
// without a server (GitHub Actions publishes it to the `data` branch; see README).
//   node export.js [outDir]
const fs = require('fs');
const path = require('path');

const db = require('./db');
const queries = require('./queries');
const { syncData, getStatus } = require('./worker');
const { snapshotTroves } = require('./troves');

const outDir = path.resolve(process.argv[2] || 'out');

async function main() {
    await syncData();
    // Troves tab: a failed snapshot keeps the previous one (and never affects the redemption data)
    try {
        await snapshotTroves();
    } catch (e) {
        console.warn(`Trove snapshot not updated: ${e.shortMessage || e.message}`);
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
    if (troves) write('troves.json', troves);
    write('trovehits.json', queries.troveHits());
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
