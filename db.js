const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, 'database.sqlite'));
db.pragma('journal_mode = WAL');

// Rebuild when the stored schema predates schema.sql (including the original mock-data
// tables); every row is derived from chain data and is re-synced from scratch
const cols = db.prepare('PRAGMA table_info(redemptions)').all();
if (cols.length && !cols.some(c => c.name === 'net_profit_usd')) {
    db.exec(`DROP TABLE IF EXISTS redemptions; DROP TABLE IF EXISTS redemption_events;
             DROP TABLE IF EXISTS bots; DROP TABLE IF EXISTS sync_state;`);
}

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

module.exports = db;
