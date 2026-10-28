// Vercel function: the webhook of @BoldbotAlertsBot. Telegram sends every message and button press here; the function
// keeps the subscriptions in Upstash Redis and answers in the chat. The alerts themselves are sent by alerts.js in the
// 30-minute job. No dependencies (Vercel installs none for this project): Telegram and Upstash are reached with fetch.
//   /start <code>  subscribe to the trove in the code (the "Alerts on Telegram" button on boldbot.io makes the link)
//   /status        the current state of the followed troves (a button per trove, or all)
//   /safe          the lowest rate to stay in the green on each branch, and for each followed trove
//   /digest        a daily, weekly or monthly summary (sent by alerts.js at 08:00 UTC), or none
//   /list          the troves this chat follows, each with a button to stop it
//   /stop          the same list (stop one), or /stop all
//   /help          how it works
// Storage: watched = set of trove keys "<branch index>:<id>"; watchers:<key> = chats; subs:<chat> = trove keys;
// state:<key> = the last reported state (written by alerts.js; deleted here when nobody follows the trove any more);
// digests = chats with a summary; digest:<chat> = { freq, since }; dstate:<chat> = the state at the last summary (alerts.js).
// The status and safe-rate texts come from api/_view.js, shared with the summaries.
const V = require('./_view');

const SITE = process.env.SITE_URL || 'https://www.boldbot.io';
const MAX_TROVES = 20;                     // troves one chat can follow
const FOOTER = '\n\n<i>ℹ️ Alerts arrive up to about 30 minutes after a change occurs on chain and are for information purposes only. Before acting on a trove, check its current state in the front end of your choice.</i>';

async function kv(...command) {
    const r = await fetch(process.env.KV_REST_API_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }, body: JSON.stringify(command)
    });
    const j = await r.json();
    if (j.error) throw new Error(`Upstash: ${j.error}`);
    return j.result;
}

const telegram = (method, params) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
}).then(r => r.json());
const reply = (chat, text, extra = {}) => telegram('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

// A trove in a Telegram start code: "t" + branch index + its 32-byte id in base64url (45 characters; Telegram allows 64)
const codeOf = key => { const [b, id] = key.split(':'); return `t${b}${Buffer.from(id.slice(2), 'hex').toString('base64url')}`; };
function keyOf(code) {
    const m = /^t(\d)([A-Za-z0-9_-]{43})$/.exec(code || '');
    if (!m) return null;
    const hex = Buffer.from(m[2], 'base64url').toString('hex');
    return hex.length === 64 ? `${m[1]}:0x${hex}` : null;
}
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = v => `${Number(v).toFixed(2)}%`;

// The published trove snapshot, to check a trove and describe it
async function snapshot() {
    const r = await fetch(`${SITE}/data/troves.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`trove data: HTTP ${r.status}`);
    return r.json();
}
const describe = (snap, key) => {
    const [b, id] = key.split(':'), t = snap.troves.find(x => x.branch === Number(b) && x.id === id);
    return t ? { t, branch: snap.branches[t.branch].name, link: `${SITE}/?trove=${encodeURIComponent(snap.branches[t.branch].name)}:${t.id}` } : null;
};

const HELP = 'This bot sends alerts about Liquity V2 troves, from <a href="' + SITE + '">boldbot.io</a>.\n\n'
    + '<b>To follow a trove</b>, open it on boldbot.io (Troves tab) and tap <b>Alerts on Telegram</b>. You can follow any trove, not only your own, up to ' + MAX_TROVES + '.\n\n'
    + '<b>You get an alert when</b>\n• a self-managed trove is redeemed against (all redemptions of a run in one alert)\n• a batch in front of a self-managed trove moves its rate above it (the trove moves forward in the redemption queue)\n'
    + '• redemptions hit troves of the batch a trove belongs to\n• the batch manager changes the rate\n• the trove leaves a batch, joins one, becomes a zombie or closes\n\n'
    + '/status the current state of the troves you follow\n/safe the lowest rate to stay in the green on each branch\n'
    + '/digest a daily, weekly or monthly summary\n/list the troves you follow · /stop stops one or all' + FOOTER;

async function subscribe(chat, key) {
    const snap = await snapshot(), d = describe(snap, key);
    if (!d) return reply(chat, 'This trove is not open any more, or the link is incomplete. Open a trove on <a href="' + SITE + '">boldbot.io</a> and tap <b>Alerts on Telegram</b> again.');
    if (d.t.status !== 1) return reply(chat, `Trove ${short(d.t.id)} is a zombie trove, out of the redemption queue, so there is nothing to follow.`);
    const mine = await kv('SMEMBERS', `subs:${chat}`);
    if (mine.includes(key)) return reply(chat, `You already follow trove <a href="${d.link}">${short(d.t.id)}</a> on ${d.branch}. /list shows all the troves you follow.`);
    if (mine.length >= MAX_TROVES) return reply(chat, `You follow ${MAX_TROVES} troves, the most one chat can follow. Stop one with /stop first.`);
    await kv('SADD', `subs:${chat}`, key);
    await kv('SADD', `watchers:${key}`, String(chat));
    await kv('SADD', 'watched', key);
    const what = d.t.batchManager
        ? `Its rate is set by batch manager ${short(d.t.batchManager)}. You will get an alert when redemptions hit troves of the batch, when the manager changes the rate, or when the trove leaves the batch, becomes a zombie or closes.`
        : `Its rate is set by the owner. You will get an alert when it is redeemed against, when a batch in front of it moves its rate above it, when it joins a batch, becomes a zombie or closes.`;
    return reply(chat, `✅ <b>You now follow trove <a href="${d.link}">${short(d.t.id)}</a></b> · ${d.branch} · ${pct(d.t.rate)}\n${what}\n\nAlerts start from the next data update, within about 30 minutes. /list shows the troves you follow.${FOOTER}`);
}

async function unsubscribe(chat, key) {
    await kv('SREM', `subs:${chat}`, key);
    await kv('SREM', `watchers:${key}`, String(chat));
    if (!(await kv('SCARD', `watchers:${key}`))) { await kv('SREM', 'watched', key); await kv('DEL', `state:${key}`); }
}

const mineOf = async chat => (await kv('SMEMBERS', `subs:${chat}`)).sort();   // one order everywhere: lists, buttons, messages
const NONE = 'You do not follow any trove yet. Open a trove on <a href="' + SITE + '">boldbot.io</a> and tap <b>Alerts on Telegram</b>.';
const troveLines = (snap, keys) => keys.map((key, i) => { const d = describe(snap, key); return d ? `${i + 1}. <a href="${d.link}">${short(d.t.id)}</a> · ${d.branch} · ${pct(d.t.rate)}${d.t.batchManager ? ` · batch ${short(d.t.batchManager)}` : ' · self-managed'}` : `${i + 1}. ${short(key.split(':')[1])} (no longer open)`; });

// The troves of a chat, each with a stop button
async function list(chat, intro) {
    const mine = await mineOf(chat);
    if (!mine.length) return reply(chat, NONE);
    const snap = await snapshot();
    const lines = troveLines(snap, mine);
    const buttons = mine.map((key, i) => [{ text: `Stop ${i + 1}. ${short(key.split(':')[1])}`, callback_data: `stop:${codeOf(key)}` }]);
    if (mine.length > 1) buttons.push([{ text: 'Stop all', callback_data: 'stop:all' }]);
    return reply(chat, `${intro || '<b>Troves you follow</b>'}\n${lines.join('\n')}`, { reply_markup: { inline_keyboard: buttons } });
}

// /status: one trove directly; with several, a button per trove and one for all ("All" first)
async function sendStatus(chat, keys) {
    const snap = await snapshot();
    for (const text of V.statusMessages(snap, keys)) await reply(chat, text);
}
async function status(chat) {
    const mine = await mineOf(chat);
    if (!mine.length) return reply(chat, NONE);
    if (mine.length === 1) return sendStatus(chat, mine);
    const snap = await snapshot();
    const buttons = [[{ text: 'All', callback_data: 'status:all' }], ...mine.map((key, i) => [{ text: `${i + 1}. ${short(key.split(':')[1])}`, callback_data: `status:${codeOf(key)}` }])];
    return reply(chat, `📋 <b>Which trove?</b>\n${troveLines(snap, mine).join('\n')}`, { reply_markup: { inline_keyboard: buttons } });
}

// /safe: the lowest rate to stay in the green, per branch and for each followed trove
async function safe(chat) {
    const [snap, mine] = [await snapshot(), await mineOf(chat)];
    for (const text of V.safeMessages(snap, mine)) await reply(chat, text);
}

// /digest: choose a daily, weekly or monthly summary, or none (alerts.js sends it at 08:00 UTC)
const SCHEDULE = { daily: 'every day at 08:00 UTC', weekly: 'every Monday at 08:00 UTC', monthly: 'on the 1st of each month at 08:00 UTC' };
async function digest(chat) {
    const raw = await kv('GET', `digest:${chat}`), now = raw ? JSON.parse(raw).freq : null;
    const buttons = [[{ text: 'Daily', callback_data: 'digest:daily' }, { text: 'Weekly', callback_data: 'digest:weekly' },
        { text: 'Monthly', callback_data: 'digest:monthly' }, { text: 'Off', callback_data: 'digest:off' }]];
    return reply(chat, `📬 <b>Summary of the troves you follow</b>\nHow often would you like to receive it?\nNow: ${now ? SCHEDULE[now] : 'off'}`,
        { reply_markup: { inline_keyboard: buttons } });
}
async function setDigest(chat, freq) {
    if (freq === 'off') {
        await kv('DEL', `digest:${chat}`, `dstate:${chat}`);
        await kv('SREM', 'digests', String(chat));
        return reply(chat, `Summaries are off.\nTo start them again, call /digest.${FOOTER}`);
    }
    // since = now: the first summary comes at the next scheduled time, not at once
    await kv('SET', `digest:${chat}`, JSON.stringify({ freq, since: Date.now() }));
    await kv('SADD', 'digests', String(chat));
    const none = (await kv('SCARD', `subs:${chat}`)) ? '' : '\nYou do not follow any trove yet: the summary starts once you do.';
    return reply(chat, `✅ You will receive a summary ${SCHEDULE[freq]}.${none}\nTo change the frequency of the summary or stop it completely, call /digest.${FOOTER}`);
}

async function handle(update) {
    // a button under a message: a trove's status (/status), the summary frequency (/digest) or stop (/list, /stop)
    if (update.callback_query) {
        const q = update.callback_query, chat = q.message?.chat?.id, data = q.data || '';
        if (chat && data.startsWith('status:')) {
            const mine = await mineOf(chat), key = data === 'status:all' ? null : keyOf(data.slice(7));
            await telegram('answerCallbackQuery', { callback_query_id: q.id, text: key ? 'Status of the trove' : 'Status of all your troves' });
            const keys = key ? (mine.includes(key) ? [key] : []) : mine;
            return keys.length ? sendStatus(chat, keys) : reply(chat, key ? 'You no longer follow this trove. /status shows the troves you follow.' : NONE);
        }
        if (chat && data.startsWith('digest:')) {
            const freq = data.slice(7);
            if (!SCHEDULE[freq] && freq !== 'off') return telegram('answerCallbackQuery', { callback_query_id: q.id });
            await telegram('answerCallbackQuery', { callback_query_id: q.id, text: freq === 'off' ? 'Summaries off' : `Summary: ${freq}` });
            await telegram('deleteMessage', { chat_id: chat, message_id: q.message.message_id }).catch(() => {});
            return setDigest(chat, freq);
        }
        if (chat && data === 'stop:all') { for (const key of await kv('SMEMBERS', `subs:${chat}`)) await unsubscribe(chat, key); }
        else if (chat && data.startsWith('stop:')) { const key = keyOf(data.slice(5)); if (key) await unsubscribe(chat, key); }
        await telegram('answerCallbackQuery', { callback_query_id: q.id, text: data === 'stop:all' ? 'Stopped all alerts' : 'Alerts stopped for this trove' });
        if (chat) {
            await telegram('deleteMessage', { chat_id: chat, message_id: q.message.message_id }).catch(() => {});
            const left = await kv('SCARD', `subs:${chat}`);
            return left ? list(chat, '<b>Troves you still follow</b>') : reply(chat, 'You no longer follow any trove.');
        }
        return;
    }
    const msg = update.message;
    if (!msg?.text || !msg.chat) return;
    const chat = msg.chat.id, [command, arg] = msg.text.trim().split(/\s+/, 2), cmd = command.toLowerCase().replace(/@\w+$/, '');
    if (cmd === '/start' && arg) {
        const key = keyOf(arg);
        return key ? subscribe(chat, key) : reply(chat, 'This link is not a trove link. ' + HELP);
    }
    if (cmd === '/list') return list(chat);
    if (cmd === '/status') return status(chat);
    if (cmd === '/safe') return safe(chat);
    if (cmd === '/digest') return digest(chat);
    if (cmd === '/stop') {
        if ((arg || '').toLowerCase() === 'all') { for (const key of await kv('SMEMBERS', `subs:${chat}`)) await unsubscribe(chat, key); return reply(chat, 'You no longer follow any trove.'); }
        return list(chat, '<b>Which trove should stop?</b> Tap a button below.');
    }
    return reply(chat, HELP);              // /start without a code, /help and anything else
}

module.exports = async (req, res) => {
    // only Telegram knows the secret set with the webhook
    if (req.method !== 'POST' || req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(401).end();
    try {
        await handle(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
    } catch (e) {
        console.error('telegram webhook:', e.message);
    }
    res.status(200).end();                 // always 200: Telegram would otherwise repeat the update
};
module.exports.handle = handle;
module.exports.codeOf = codeOf;
module.exports.keyOf = keyOf;
