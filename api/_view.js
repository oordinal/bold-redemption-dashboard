// Shared by the bot (api/telegram.js: /status, /safe) and the summaries (alerts.js: runDigests): a trove's place in the
// redemption queue, its colour band, collateral ratio and liquidation price, and the lowest rate that stays in the green.
// Same rules as the alerts and the page: redemption order (the branch's zombie trove first, then the lowest rate), the branch's
// share of a redemption (debt not covered by the Stability Pool), and the typical and busiest week of the last 180 days.
// Pure functions on a trove snapshot (troves.json). No dependencies; the underscore keeps Vercel from serving it as an endpoint.
const SITE = process.env.SITE_URL || 'https://www.boldbot.io';
const MIN_RATE = 0.5;                       // Liquity V2's lowest interest rate (%)

// ---------------------------------------------------------------- Formatting (as in alerts.js)
const compact = v => {
    const a = Math.abs(v);
    return a >= 1e9 ? `${+(v / 1e9).toFixed(2)}b` : a >= 1e6 ? `${+(v / 1e6).toFixed(2)}m` : a >= 1e3 ? `${+(v / 1e3).toFixed(2)}k` : `${+v.toFixed(2)}`;
};
const pct = (v, d = 2) => `${v.toFixed(d)}%`;
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = v => `$${Math.round(v).toLocaleString('en-US')}`;
const whole = v => Math.round(v).toLocaleString('en-US');
const amount = v => Number(v.toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const day = ms => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const dayShort = ms => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const monthOf = ms => { const d = new Date(ms); return `${FULL_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const stamp = ms => { const d = new Date(ms); return `${day(ms)}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };

// The last lines of every message: the link to the trove (where there is one) and the same reminder as every alert
const FOOTER = '\n\n<i>ℹ️ Alerts arrive up to about 30 minutes after a change occurs on chain and are for information purposes only. Before acting on a trove, check its current state in the front end of your choice.</i>';
const troveUrl = t => `${SITE}/?trove=${encodeURIComponent(t.b.name)}:${t.id}`;
const linkLine = t => `<a href="${troveUrl(t)}">Open this trove on boldbot.io →</a> 🤖👀`;
const BAND = {
    red: '🔴 within reach of a typical week of redemptions',
    amber: '🟠 within reach of a week as busy as the busiest of the last 180 days',
    green: '🟢 beyond the busiest week of the last 180 days'
};
const dot = b => BAND[b] ? BAND[b].split(' ')[0] : '';

// ---------------------------------------------------------------- The queue model
// weeks: { typical, busiest } BOLD redeemed in a typical (mean) and the busiest 7-day window of the last 180 days
function model(snap, weeks = snap.weeks) {
    const branches = snap.branches.map(b => ({ ...b, unbacked: Math.max(b.debt - b.spDeposits, 0) }));
    const totalUnbacked = branches.reduce((a, b) => a + b.unbacked, 0), totalDebt = branches.reduce((a, b) => a + b.debt, 0);
    // Liquity splits a redemption by the debt not covered by the Stability Pool; by total debt if every branch is covered
    branches.forEach(b => { b.share = totalUnbacked ? b.unbacked / totalUnbacked : totalDebt ? b.debt / totalDebt : 0; });
    const managers = new Map(snap.managers.map(m => [`${m.branch}:${m.address}`, m]));
    const troves = new Map(snap.troves.map(t => [`${t.branch}:${t.id}`, { ...t, key: `${t.branch}:${t.id}`, b: branches[t.branch],
        mgr: t.batchManager ? managers.get(`${t.branch}:${t.batchManager}`) || null : null }]));
    for (const b of branches) {
        const all = [...troves.values()].filter(t => t.branch === b.index);
        b.zombie = b.lastZombie ? all.find(t => t.id === b.lastZombie) || null : null;
        b.sorted = all.filter(t => t.queue != null).sort((x, y) => x.queue - y.queue);
        b.queue = [...(b.zombie ? [b.zombie] : []), ...b.sorted];
        let front = 0;
        b.queue.forEach((t, i) => { t.position = i + 1; t.front = front; front += t.debt; });
    }
    return { snap, branches, troves, managers, weeks: weeks && weeks.typical ? weeks : null };
}

// The colour band of a trove: debt in front over the branch's share of a redemption, against the typical and busiest week
function band(m, t) {
    if (!m.weeks || t.front == null) return null;
    const system = t.b.share > 0 ? t.front / t.b.share : Infinity;
    return !isFinite(system) || system > m.weeks.busiest ? 'green' : system > m.weeks.typical ? 'amber' : 'red';
}

// The lowest rate at which a trove would have more debt in front than the busiest week needs, on branch b. Troves in
// `exclude` (the trove itself, or its whole batch) are left out. Returns { any } when the branch takes no redemptions,
// { none } when even the last place is within reach, otherwise { rate, need, front, counted } (counted: the troves in front)
function lowestGreen(m, b, exclude = new Set()) {
    if (!(b.share > 0)) return { any: true };
    const need = m.weeks.busiest * b.share;
    let front = b.zombie && !exclude.has(b.zombie.id) ? b.zombie.debt : 0, last = null;
    const counted = b.zombie && !exclude.has(b.zombie.id) ? [b.zombie] : [];
    for (const t of b.sorted) {
        if (front > need) break;
        if (exclude.has(t.id)) continue;
        front += t.debt; last = t; counted.push(t);
    }
    if (front <= need) return { none: true, need };
    // just above the last trove needed in front (a rate equal to it would not be enough to be behind it)
    const rate = last ? Math.max(MIN_RATE, Math.round((last.rate + 0.01) * 100) / 100) : MIN_RATE;
    return { rate, need, front, counted };
}

// For one branch: the lowest green rate, and how much of that protection sits in its three largest troves
function branchSafe(m, b) {
    const s = lowestGreen(m, b);
    if (!s.rate) return s;
    const top = [...s.counted].sort((x, y) => y.debt - x.debt).slice(0, 3), topDebt = top.reduce((a, t) => a + t.debt, 0);
    if (topDebt / s.front > 0.5) {
        const without = lowestGreen(m, b, new Set(top.map(t => t.id)));
        s.concentration = { share: topDebt / s.front, n: top.length, lo: Math.min(...top.map(t => t.rate)), hi: Math.max(...top.map(t => t.rate)), without };
    }
    return s;
}

// ---------------------------------------------------------------- Message parts
const kind = t => t.mgr ? `batch ${short(t.mgr.address)}` : t.batchManager ? `batch ${short(t.batchManager)}` : 'self-managed';
const troveTitle = (i, t) => `<b>${i}. ${short(t.id)} · ${esc(t.b.name)} · ${pct(t.rate)} · ${kind(t)}</b>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One trove's status block. extra: { was: { band, front }, period: a line about the period of a summary }
function statusBlock(m, i, key, extra = {}) {
    const t = m.troves.get(key);
    if (!t) return `<b>${i}. ${short(key.split(':')[1])}</b>\nNo longer open: the trove was closed or liquidated.`;
    if (t.status !== 1) return `${troveTitle(i, t)}\nOut of the redemption queue: a zombie trove, its debt below the 2,000 BOLD minimum.\n${linkLine(t)}`;
    const bd = band(m, t), was = extra.was || {};
    const bandLine = bd ? `${BAND[bd]}${was.band && was.band !== bd ? ` (was ${dot(was.band)})` : ''}` : 'Colour band not available yet';
    const queueLine = t.front == null ? 'Queue position not available' : t.front === 0 ? `Queue: <b>first</b> of ${t.b.queue.length} · nothing in front` :
        `Queue: ${t.position} of ${t.b.queue.length} · <b>${compact(t.front)} BOLD</b> in front${was.front != null && Math.abs(was.front - t.front) >= 1 ? ` (was ${compact(was.front)})` : ''}`;
    const cr = t.coll * t.b.oraclePrice / t.debt * 100, liq = t.b.mcr * t.debt / t.coll, drop = (liq / t.b.oraclePrice - 1) * 100;
    const liqLine = liq >= t.b.oraclePrice ? `Liquidation price ${usd(liq)} per ${esc(t.b.name)}, at or above the current ${usd(t.b.oraclePrice)}`
        : `Liquidation below ${usd(liq)} per ${esc(t.b.name)} (now ${usd(t.b.oraclePrice)}, ${drop.toFixed(0).replace('-', '−')}%)`;
    return [troveTitle(i, t), bandLine, queueLine, extra.period, `Debt ${whole(t.debt)} BOLD · collateral ratio ${cr.toFixed(0)}%`, liqLine, linkLine(t)]
        .filter(Boolean).join('\n');
}

// Joins blocks into messages under Telegram's limit (4,096 characters), each with the footer; the tail goes on the last one
function pack(head, blocks, tail, limit = 3800) {
    const out = []; let cur = head;
    for (const blk of blocks) {
        if (cur.length + blk.length + 2 + FOOTER.length > limit && cur !== head) { out.push(cur + FOOTER); cur = head.split('\n')[0] + ' (continued)'; }
        cur += `\n\n${blk}`;
    }
    out.push(cur + (tail ? `\n\n${tail}` : '') + FOOTER);
    return out;
}
const weeksLine = m => m.weeks ? `a typical week ${compact(m.weeks.typical)}, the busiest of the last 180 days ${compact(m.weeks.busiest)}` : '';
const SAFE_HINT = '/safe shows the lowest rate to stay in the green.';

// /status: the troves in keys (in that order)
function statusMessages(snap, keys) {
    const m = model(snap);
    const tail = [m.weeks ? `Redemptions: ${weeksLine(m)}${snap.boldUsd != null ? ` · BOLD $${snap.boldUsd.toFixed(4)}` : ''}` : null, SAFE_HINT].filter(Boolean).join('\n');
    return pack(`📋 <b>${keys.length === 1 ? 'Your trove' : 'Your troves'}</b> · ${stamp(snap.ts * 1000)}`, keys.map((k, i) => statusBlock(m, i + 1, k)), tail);
}

// /safe: the lowest green rate on every branch, then the followed troves
function safeMessages(snap, keys) {
    const m = model(snap);
    const head = `🛡 <b>Lowest rate to stay in the green</b> · ${stamp(snap.ts * 1000)}`;
    if (!m.weeks) return [`${head}\n\nNot available yet: the redemption history is being prepared. Try again in about 30 minutes.${FOOTER}`];
    const branchLines = m.branches.map(b => {
        const s = branchSafe(m, b), name = `<b>${esc(b.name)}:</b>`;
        if (s.any) return `${name} any rate\nthe Stability Pool covers the branch: it takes no redemptions now`;
        if (s.none) return `${name} no rate\neven the last place in the queue is within reach of the busiest week (${compact(s.need)} BOLD)`;
        let line = `${name} <b>${pct(s.rate)}</b>\nneeds ${compact(s.need)} BOLD in front (the branch takes ${(b.share * 100).toFixed(0)}% of each redemption)`;
        const c = s.concentration;
        if (c) line += `\n⚠️ ${(c.share * 100).toFixed(0)}% of that protection sits in ${plural(c.n, 'trove')} at ${c.lo === c.hi ? pct(c.lo) : `${c.lo.toFixed(2)}–${pct(c.hi)}`}. `
            + (c.without.rate ? `Without them, ${pct(c.without.rate)} would be needed.` : c.without.any ? '' : 'Without them, no rate would be enough.');
        return line;
    });
    const troveBlocks = keys.map((key, i) => {
        const t = m.troves.get(key);
        if (!t) return `<b>${i + 1}. ${short(key.split(':')[1])}</b>\nNo longer open: the trove was closed or liquidated.`;
        if (t.status !== 1) return `${troveTitle(i + 1, t)}\nOut of the redemption queue (zombie trove).\n${linkLine(t)}`;
        const bd = band(m, t), title = `<b>${i + 1}. ${short(t.id)} · ${esc(t.b.name)} · ${pct(t.rate)}</b> ${dot(bd)}`;
        let text;
        if (bd === 'green') text = t.mgr ? `This trove is in the green at its current rate, which is set by batch manager ${short(t.mgr.address)}.` : 'This trove is in the green at its current rate.';
        else {
            const own = new Set(t.mgr ? t.b.sorted.filter(x => x.batchManager === t.batchManager).map(x => x.id) : [t.id]);
            const s = lowestGreen(m, t.b, own);
            if (s.none) text = 'No rate would keep this trove in the green now: even the last place in the queue is within reach of the busiest week.';
            else if (t.mgr) text = `A rate of ${pct(s.rate)} would keep this trove in the green; its rate is set by batch manager ${short(t.mgr.address)}.`;
            else text = `A rate of ${pct(s.rate)} would keep this trove in the green` + (s.rate > t.rate ? `, at about ${usd(t.debt * (s.rate - t.rate) / 100)} a year more on ${whole(t.debt)} BOLD.` : '.');
        }
        return `${title}\n${text}\n${linkLine(t)}`;
    });
    const caution = 'Be smart: changing a rate within 7 days of the last change costs an upfront fee (7 days of average interest). Think it through, and remember this is not financial advice or a suggestion to take any action.';
    return pack(`${head}\n\n${branchLines.join('\n\n')}${keys.length ? '\n\n<b>Your troves</b>' : ''}`, troveBlocks, caution);
}

// A summary: freq 'daily' | 'weekly' | 'monthly'; from/to: the period (ms); perTrove: key -> { was, hits, mgrChanged };
// redeemed: BOLD redeemed in the whole system in the period
const PERIOD = { daily: 'Last 24 hours', weekly: 'This week', monthly: 'This month' };
function digestMessages(snap, weeks, freq, from, to, keys, perTrove, redeemed) {
    const m = model(snap, weeks), label = PERIOD[freq];
    const title = freq === 'daily' ? `📬 <b>Daily summary</b> · ${day(to)}` : freq === 'weekly' ? `📬 <b>Weekly summary</b> · ${dayShort(from)} – ${day(to)}`
        : `📬 <b>Monthly summary</b> · ${monthOf(from)}`;
    const blocks = keys.map((key, i) => {
        const t = m.troves.get(key), p = perTrove[key] || {}, h = p.hits || { txs: 0 };
        let period = null;
        if (t && t.status === 1) {
            period = `${label}: ` + (h.txs ? `${plural(h.txs, 'redemption')} repaid ${compact(h.debt)} BOLD and removed ${amount(h.coll)} ${esc(t.b.name)}; result at the time: `
                + (h.result >= 0 ? `+${usd(h.result)} in the trove's favour` : `${usd(-h.result)} cost to the trove`) : 'no redemptions on this trove');
            if (t.mgr) period += p.mgrChanged ? `; the batch manager changed the rate to ${pct(t.mgr.rate)} (+ ${pct(t.mgr.fee)} fee)` : '; the batch manager did not change the rate';
        }
        return statusBlock(m, i + 1, key, { was: p.was, period });
    });
    const tail = [`Redemptions ${label === 'Last 24 hours' ? 'in the last 24 hours' : label.toLowerCase()}: ${compact(redeemed)} BOLD${m.weeks ? ` (${weeksLine(m)})` : ''}`, SAFE_HINT].join('\n');
    return pack(title, blocks, tail);
}

// The state kept at each summary, to show what changed by the next one
function digestState(snap, weeks, keys) {
    const m = model(snap, weeks), out = {};
    for (const key of keys) { const t = m.troves.get(key); if (t && t.status === 1) out[key] = { band: band(m, t), front: t.front }; }
    return out;
}

module.exports = { model, band, lowestGreen, branchSafe, statusBlock, statusMessages, safeMessages, digestMessages, digestState, pack, FOOTER, linkLine, stamp, day };
