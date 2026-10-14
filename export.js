// Syncs new redemptions, then writes the dashboard data as static JSON for hosting
// without a server (GitHub Actions publishes it to the `data` branch; see README).
//   node export.js [outDir]
const fs = require('fs');
const path = require('path');

const db = require('./db');
const queries = require('./queries');
const { syncData, getStatus } = require('./worker');

const outDir = path.resolve(process.argv[2] || 'out');

async function main() {
    await syncData();

    fs.mkdirSync(outDir, { recursive: true });
    const write = (name, data) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(data));
    const { lastSyncedBlock, finishedAt } = getStatus();
    write('redemptions.json', queries.redemptions(50000));
    write('bots.json', queries.bots());
    write('stats.json', queries.stats());
    write('status.json', { running: false, lastSyncedBlock, generatedAt: finishedAt, lastError: null });

    // Fold the WAL into the main file so database.sqlite alone carries the full state
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    fs.copyFileSync(path.join(__dirname, 'database.sqlite'), path.join(outDir, 'database.sqlite'));
    console.log(`Exported to ${outDir} (block ${lastSyncedBlock})`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
