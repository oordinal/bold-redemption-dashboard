// Telegram alerts for watched troves (@BoldbotAlertsBot). Runs after each trove snapshot, in the same job, and compares
// every watched trove with the state last reported for it (kept in Upstash Redis), so each change is reported once even if
// a run is repeated. Three alerts:
//   - self-managed trove: a batch that was in front of it moved its rate above the trove's (the trove moves forward)
//   - trove in a batch: redemptions hit troves of the batch; and/or the batch manager changed the rate
//   - the trove closed or became a zombie: a last message, and the subscription ends
// The queue figures follow the page's own rules (debt in front, system-wide distance, typical and busiest week).
// Storage (Upstash, REST): watched = set of trove keys "<branch index>:<id>"; watchers:<key> = set of chat ids;
// subs:<chat> = set of trove keys; state:<key> = JSON of the last reported state.
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');

const SITE = process.env.SITE_URL || 'https://www.boldbot.io';
const DAY = 86400e3;

// ---------------------------------------------------------------- Upstash and Telegram
async function kv(...command) {
    const r = await fetch(process.env.KV_REST_API_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, body: JSON.stringify(command)
    });
    const j = await r.json();
    if (j.error) throw new Error(`Upstash: ${j.error}`);
    return j.result;
}

async function telegram(method, params) {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
    });
    return r.json();
}

// ---------------------------------------------------------------- Formatting
const compact = v => {
    const a = Math.abs(v);
    const s = a >= 1e9 ? `${+(v / 1e9).toFixed(2)}b` : a >= 1e6 ? `${+(v / 1e6).toFixed(2)}m` : a >= 1e3 ? `${+(v / 1e3).toFixed(2)}k` : `${+v.toFixed(2)}`;
    return s;
};
const pct = (v, d = 2) => `${v.toFixed(d)}%`;
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const BAND = {
    red: '🔴 within reach of a typical week of redemptions',
    amber: '🟠 within reach of a week as busy as the busiest of the last 180 days',
    green: '🟢 beyond the busiest week of the last 180 days'
};
const bandText = b => b ? BAND[b] : 'no redemption share on this branch now';

// ---------------------------------------------------------------- The queue model (the page's rules)
// Typical and busiest week: the mean and the largest of every 7-day window of the 180 days before the snapshot
const weekRows = db.prepare('SELECT timestamp, amount FROM redemptions WHERE timestamp > ? AND timestamp <= ?');
function weekVolumes(endMs) {
    const start = endMs - 180 * DAY, daily = new Array(180).fill(0);
    for (const r of weekRows.all(start, endMs)) daily[Math.min(179, Math.floor((r.timestamp - start) / DAY))] += r.amount;
    const sums = [];
    for (let i = 0; i + 7 <= 180; i++) sums.push(daily.slice(i, i + 7).reduce((a, v) => a + v, 0));
    return { weekVol: sums.reduce((a, v) => a + v, 0) / sums.length, maxWeek: Math.max(...sums) };
}

function buildModel(snap) {
    const branches = snap.branches.map(b => ({ ...b, unbacked: Math.max(b.debt - b.spDeposits, 0) }));
    const totalUnbacked = branches.reduce((a, b) => a + b.unbacked, 0), totalDebt = branches.reduce((a, b) => a + b.debt, 0);
    // Liquity splits a redemption by debt not covered by the Stability Pool; by total debt if every branch is covered
    branches.forEach(b => { b.share = totalUnbacked ? b.unbacked / totalUnbacked : totalDebt ? b.debt / totalDebt : 0; });
    const managers = new Map(snap.managers.map(m => [`${m.branch}:${m.address}`, m]));
    const troves = new Map(snap.troves.map(t => [`${t.branch}:${t.id}`, { ...t, key: `${t.branch}:${t.id}`, b: branches[t.branch],
        mgr: t.batchManager ? managers.get(`${t.branch}:${t.batchManager}`) || null : null }]));
    for (const b of branches) {
        // Redemption order: the branch's most recent zombie trove first, then the sorted list from the lowest rate up
        const all = [...troves.values()].filter(t => t.branch === b.index);
        const zombie = b.lastZombie ? all.find(t => t.id === b.lastZombie) : null;
        b.queue = [...(zombie ? [zombie] : []), ...all.filter(t => t.queue != null).sort((x, y) => x.queue - y.queue)];
        let front = 0;
        b.queue.forEach((t, i) => { t.position = i + 1; t.front = front; front += t.debt; });
    }
    return { snap, branches, troves, managers, ...weekVolumes(snap.ts * 1000) };
}

const bandOf = (model, system) => system == null || !model.weekVol ? null
    : !isFinite(system) || system > model.maxWeek ? 'green' : system > model.weekVol ? 'amber' : 'red';

// What the alerts need about one trove, now
function troveView(model, key) {
    const t = model.troves.get(key);
    if (!t) return { key, gone: true };
    const b = t.b, system = t.front == null ? null : b.share > 0 ? t.front / b.share : Infinity;
    const ahead = new Map();
    for (const x of b.queue.slice(0, (t.position || 1) - 1)) if (x.batchManager && x.batchManager !== t.batchManager) {
        const g = ahead.get(x.batchManager) || { troves: 0, debt: 0 };
        g.troves++; g.debt += x.debt; ahead.set(x.batchManager, g);
    }
    const members = t.mgr ? b.queue.filter(x => x.batchManager === t.batchManager) : [];
    const k = members.indexOf(t);
    return { key, t, b, zombie: t.status !== 1, front: t.front, position: t.position, queueLength: b.queue.length, system,
        band: bandOf(model, system), ahead, members, k, batchAhead: members.slice(0, Math.max(k, 0)).reduce((a, x) => a + x.debt, 0),
        batchDebt: members.reduce((a, x) => a + x.debt, 0) };
}

// The state reported for a trove, kept to compare with the next run
function stateOf(view, model, hitBlock) {
    const { t } = view;
    return { block: model.snap.block, ts: model.snap.ts, front: view.front, position: view.position, band: view.band, rate: t.rate, debt: t.debt,
        mgr: t.mgr ? t.mgr.address : null, mgrRate: t.mgr ? t.mgr.rate : null, mgrFee: t.mgr ? t.mgr.fee : null,
        mgrChange: t.mgr ? t.mgr.lastRateChange : null, hitBlock,
        // batches in front: each one's last rate change and rate, to spot one that moves above the trove
        ahead: Object.fromEntries([...view.ahead.keys()].map(m => { const mg = model.managers.get(`${t.branch}:${m}`); return [m, [mg?.lastRateChange ?? null, mg?.rate ?? null]]; })) };
}

// Redemption hits on a batch's troves (at the time of each hit) in a block range
const hitRows = db.prepare(`SELECT r.block, r.tx_hash, t.trove_id, t.debt_redeemed FROM redemption_troves t JOIN redemptions r USING (tx_hash)
    WHERE t.branch = ? AND t.batch_manager = ? AND r.block > ? AND r.block <= ?`);
function batchHits(branchName, manager, fromBlock, toBlock) {
    const rows = hitRows.all(branchName, manager, fromBlock, toBlock);
    return { txs: new Set(rows.map(r => r.tx_hash)).size, troves: new Set(rows.map(r => r.trove_id)), debt: rows.reduce((a, r) => a + r.debt_redeemed, 0), rows };
}

// ---------------------------------------------------------------- Detection and messages
const troveLink = view => `${SITE}/?trove=${encodeURIComponent(view.b.name)}:${view.t.id}`;
const head = (view, title) => `<b>${title}</b>\nTrove <a href="${troveLink(view)}">${short(view.t.id)}</a> · ${esc(view.b.name)} · ${pct(view.t.rate)}`;
// asResult: the sentence follows the event that changed it ("As a result, the debt in front…")
const frontLine = (view, state, asResult) => view.front === 0
    ? `${asResult ? 'As a result, this' : 'This'} trove is now <b>first in the redemption queue</b> of the ${esc(view.b.name)} branch: the next redemption reaching the branch starts with it.`
    : `${state.front !== view.front ? `${asResult ? 'As a result, the' : 'The'} debt in front of this trove changed from ${compact(state.front)} to <b>${compact(view.front)} BOLD</b>.`
    : `The debt in front of this trove is <b>${compact(view.front)} BOLD</b>.`} The trove is now ${view.position} of ${view.queueLength} in the redemption queue of the ${esc(view.b.name)} branch.`;
// green: "still beyond…" when it was green before, "now beyond…" when it has just become green; any change shows the previous colour
const statusLine = (view, state) => {
    const was = state.band !== view.band ? ` (was ${bandText(state.band).split(' ')[0]})` : '';
    const text = view.band === 'green' ? `🟢 ${state.band === 'green' ? 'still' : 'now'} beyond the busiest week of the last 180 days` : bandText(view.band);
    return `Status: ${text}${was}`;
};
// The last line of every message
const FOOTER = '\n\n<i>ℹ️ Alerts arrive up to about 30 minutes after a change occurs on chain and are for information purposes only. Before acting on a trove, check its current state in the front end of your choice.</i>';

// The messages for one trove (state: last reported; view: now); { end: true } when the subscription should stop
function detect(state, view, model, hits) { return withFooter(detectAll(state, view, model, hits), view.gone ? null : troveLink(view)); }
function detectAll(state, view, model, hits) {
    if (view.gone) return { messages: [`<b>Trove no longer open</b>\nTrove ${short(view.key.split(':')[1])} was closed or liquidated. Alerts for it have stopped.`], end: true };
    if (view.zombie) return { messages: [`${head(view, 'Trove left the redemption queue')}\nIts debt fell below the 2,000 BOLD minimum after a redemption, so it is now a zombie trove, out of the queue. Alerts for it have stopped.`], end: true };
    const { t } = view, messages = [];
    // A trove that changed batch (or joined or left one): say so, then follow the new situation from the next run
    if ((t.mgr ? t.mgr.address : null) !== state.mgr) {
        messages.push(`${head(view, t.mgr ? 'Trove now in a batch' : 'Trove left its batch')}\n${t.mgr ? `Its rate is now set by batch manager ${short(t.mgr.address)} (${pct(t.mgr.rate)} + ${pct(t.mgr.fee)} fee).` : 'Its rate is now set by the owner.'}\n${frontLine(view, state)}\n${statusLine(view, state)}`);
        return { messages };
    }
    if (!t.mgr) {
        // Self-managed: batches that were in front, changed their rate and are now behind the trove in the queue
        const moved = Object.entries(state.ahead || {}).filter(([m, [change]]) => {
            const mg = model.managers.get(`${t.branch}:${m}`);
            return !view.ahead.has(m) && mg && mg.lastRateChange !== change;
        }).map(([m, [, oldRate]]) => ({ mg: model.managers.get(`${t.branch}:${m}`), oldRate }));
        if (moved.length) {
            const list = moved.map(({ mg, oldRate }) => `• Batch ${short(mg.address)} (${compact(mg.debt)} BOLD) changed its rate ${oldRate != null ? `${pct(oldRate)} → ` : 'to '}${pct(mg.rate)}`).join('\n');
            messages.push(`${head(view, moved.length === 1 ? 'A batch moved above your trove' : `${moved.length} batches moved above your trove`)}\n${list}\n${frontLine(view, state, true)}\n${statusLine(view, state)}`);
        }
    } else {
        // In a batch: redemptions on the batch, and the manager's rate
        const m = t.mgr, rateChanged = m.lastRateChange !== state.mgrChange && m.rate !== state.mgrRate;
        const parts = [];
        if (hits.txs) parts.push(`${hits.txs} redemption${hits.txs === 1 ? '' : 's'} hit ${hits.troves.size} trove${hits.troves.size === 1 ? '' : 's'} of the batch: ${compact(hits.debt)} BOLD repaid${hits.troves.has(t.id) ? ` (your trove: ${compact(hits.rows.filter(r => r.trove_id === t.id).reduce((a, r) => a + r.debt_redeemed, 0))} BOLD)` : ''}.`);
        if (rateChanged) {
            const cost = r => (r + m.fee) * t.debt / 100;
            parts.push(`The manager changed the rate: ${pct(state.mgrRate)} → <b>${pct(m.rate)}</b> (+ ${pct(m.fee)} fee). Cost per year for your trove: ${compact(cost(state.mgrRate))} → <b>${compact(cost(m.rate))} BOLD</b>.`);
        } else if (hits.txs) parts.push(`The batch has not changed its rate since (${pct(m.rate)}).`);
        if (parts.length) {
            const title = hits.txs && rateChanged ? 'Redemptions hit your batch, and its rate changed' : hits.txs ? 'Redemptions hit your batch' : 'Your batch manager changed the rate';
            messages.push(`${head(view, title)} · batch ${short(m.address)}\n${parts.join('\n')}\n${view.k === 0 ? `Your trove is first of the ${view.members.length} troves in the batch.` : `Your trove: ${view.k + 1} of ${view.members.length} in the batch, with ${compact(view.batchAhead)} BOLD of the batch ahead of it (${pct(view.batchAhead / (view.batchDebt || 1) * 100, 1)}).`}\n${frontLine(view, state)}\n${statusLine(view, state)}`);
        }
    }
    return { messages };
}
// Every message ends with a link to open the trove on the dashboard (unless it no longer exists) and the reminder line
const withFooter = ({ messages, end }, link) => ({ messages: messages.map(m => m + (link ? `\n\n<a href="${link}">Open this trove on boldbot.io →</a> 🤖👀` : '') + FOOTER), end });

// ---------------------------------------------------------------- The run
const syncedBlock = () => Number(db.prepare("SELECT value FROM sync_state WHERE key = 'last_block'").get()?.value || 0);

// Ends every subscription to a trove (it closed or became a zombie)
async function unsubscribe(key, chats) {
    for (const chat of chats) await kv('SREM', `subs:${chat}`, key);
    await kv('DEL', `watchers:${key}`, `state:${key}`);
    await kv('SREM', 'watched', key);
}

// Ends every subscription of a chat (the person blocked the bot or deleted the chat); a trove nobody watches any more
// leaves the list of watched troves
async function dropChat(chat) {
    for (const key of await kv('SMEMBERS', `subs:${chat}`)) {
        await kv('SREM', `watchers:${key}`, chat);
        if (!(await kv('SCARD', `watchers:${key}`))) { await kv('SREM', 'watched', key); await kv('DEL', `state:${key}`); }
    }
    await kv('DEL', `subs:${chat}`);
}

// Sends the alerts for every watched trove (snapshot: the latest by default). Without the Upstash or Telegram settings it
// does nothing, so the job runs as before
async function runAlerts({ snapshot } = {}) {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN || !process.env.TELEGRAM_BOT_TOKEN) return { skipped: 'not configured' };
    const snap = snapshot || require('./troves').latestTroveSnapshot();
    if (!snap) return { skipped: 'no snapshot' };
    const model = buildModel(snap), upTo = syncedBlock(), watched = await kv('SMEMBERS', 'watched');
    let sent = 0, failed = 0;
    for (const key of watched) {
        try {
            const view = troveView(model, key), raw = await kv('GET', `state:${key}`), state = raw ? JSON.parse(raw) : null;
            if (!state) {                              // a new subscription: record the current state, report from the next run
                if (!view.gone && !view.zombie) await kv('SET', `state:${key}`, JSON.stringify(stateOf(view, model, upTo)));
                continue;
            }
            if (!view.gone && view.t.status === 1 && state.block >= snap.block) continue;   // nothing newer than what was reported
            const hits = view.t?.mgr ? batchHits(view.b.name, view.t.mgr.address, state.hitBlock, upTo) : { txs: 0, troves: new Set(), debt: 0, rows: [] };
            const { messages, end } = detect(state, view, model, hits);
            const chats = await kv('SMEMBERS', `watchers:${key}`);
            for (const text of messages) for (const chat of chats) {
                const r = await telegram('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
                if (r.ok) sent++;
                else {
                    failed++;
                    if (r.error_code === 403) await dropChat(chat);   // the person blocked the bot or deleted the chat
                }
            }
            if (end) await unsubscribe(key, chats);
            // keep the state only while someone still follows the trove (a follower who blocked the bot was just removed)
            else if (await kv('SCARD', `watchers:${key}`)) await kv('SET', `state:${key}`, JSON.stringify(stateOf(view, model, upTo)));
            else await kv('DEL', `state:${key}`);
        } catch (e) {
            failed++;
            console.warn(`Alert for ${key} not sent: ${e.message}`);
        }
    }
    return { watched: watched.length, sent, failed };
}

module.exports = { runAlerts, buildModel, troveView, stateOf, detect, batchHits, kv, telegram };

if (require.main === module) {
    runAlerts().then(r => console.log('Telegram alerts:', JSON.stringify(r))).catch(e => { console.error(e.message); process.exit(1); });
}
