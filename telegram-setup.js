// One-time setup of @BoldbotAlertsBot, run locally after the bot function (api/telegram.js) is deployed:
//   node telegram-setup.js          registers the webhook (with its secret) and the command menu
//   node telegram-setup.js --check  shows what Telegram has registered
// Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const SITE = process.env.SITE_URL || 'https://www.boldbot.io';

const telegram = (method, params = {}) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
}).then(r => r.json());

async function main() {
    if (!process.argv.includes('--check')) {
        const hook = await telegram('setWebhook', { url: `${SITE}/api/telegram`, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
        console.log('webhook:', hook.ok ? 'set' : hook.description);
        const commands = await telegram('setMyCommands', { commands: [
            { command: 'list', description: 'Troves you follow' },
            { command: 'stop', description: 'Stop alerts for a trove (or /stop all)' },
            { command: 'help', description: 'How the alerts work' }] });
        console.log('commands:', commands.ok ? 'set' : commands.description);
    }
    const info = await telegram('getWebhookInfo');
    const r = info.result || {};
    console.log(`registered webhook: ${r.url || 'none'} · pending updates: ${r.pending_update_count ?? '?'}${r.last_error_message ? ` · last error: ${r.last_error_message}` : ''}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
