# BOLD Redemption Dashboard

Tracks every redemption of Liquity V2's BOLD stablecoin on Ethereum mainnet and measures what the
redeemers actually made: BOLD discount, oracle gap, redemption fee, gas, builder tips and net profit.
The **Troves** tab shows every open trove: health, place in the redemption queue, the cost of a safer rate,
its redemption record, its batch manager and who may act on it. The **Methodology** tab explains the redemption
mechanics and how the figures are computed.

## Run locally

Requires Node 20+ and an [Alchemy](https://www.alchemy.com/) API key (the free tier is enough).

```bash
cp .env.example .env        # then put your key in ALCHEMY_API_KEY (and optionally ETHERSCAN_API_KEY)
npm install
npm start                   # http://localhost:3000
```

The first start syncs every redemption since the V2 launch (about 15 minutes); after that the server
syncs new blocks every 5 minutes and the **Sync now** button triggers one on demand.

An [Etherscan](https://etherscan.io/apis) API key (free) is optional: with `ETHERSCAN_API_KEY` set, the sync looks up who
deployed each bot contract, which the Operators card uses to group contracts. Without it, deployers show as unknown.
It is also what the Troves tab's borrowing record and "refills" tag are read with (one request per branch per sync); without
it, that record is left out.

## How the hosted version works

Vercel only serves static files, so the data is produced elsewhere:

1. `.github/workflows/sync.yml` runs every 30 minutes, started by an external scheduler (and on demand from the Actions tab). It restores
   the SQLite database from the `data` branch, runs `node export.js out` to sync new redemptions,
   and force-pushes the JSON snapshot plus the database to `data` as a single commit.
2. Vercel serves `public/` and proxies `/data/*` to that branch (see `vercel.json`).
3. The page detects that there's no API and reads `data/*.json` instead.

Setup: add your Alchemy key as the repository secret `ALCHEMY_API_KEY` (and optionally your Etherscan key as
`ETHERSCAN_API_KEY`), run the workflow once, then import the repository in Vercel with the default settings.
GitHub delays or drops scheduled runs (in practice they came hours apart), so the workflow's own schedule is only a
backup that runs twice a day. The regular refresh comes from an external cron service (for example cron-job.org), which starts the
workflow every 30 minutes with a `POST` to
`https://api.github.com/repos/<owner>/<repo>/actions/workflows/sync.yml/dispatches` and the body `{"ref":"main"}`,
authenticated by a fine-grained token limited to this repository with only the Actions (read and write) permission.
Starting the workflow by hand from the Actions tab refreshes the data at once. If the external service stops, the
backup still refreshes the data about every 12 hours (GitHub may delay those runs).

## Files

| File | Role |
|---|---|
| `worker.js` | Scans `Redemption` events, enriches each tx with prices and costs, writes SQLite |
| `queries.js` | The queries behind the feed, the stats tiles and the data for the cards (trove rows, addresses) |
| `index.js` | Local server: API, static files and the periodic sync |
| `troves.js` | Troves tab: snapshot of every open trove, the branches and the batch managers, read at one block (about 8 bundled read-only calls), plus the number of active troves at the block about 30 days earlier (one more call, for the change shown on the tab), stored in the `trove_snapshot` table |
| `troveops.js` | Troves tab, borrowing record: every trove operation other than redemptions (borrowing, repaying, collateral changes, closing, rate and batch changes, liquidations), from the TroveManagers' `TroveOperation` events through Etherscan's log API, stored in the `trove_ops` table. One request per branch per sync; the first run reads the history since the V2 launch (about 20 requests) |
| `export.js` | Sync, trove snapshot, trove operations, Telegram alerts and summaries, then write the static JSON snapshot (used by the GitHub Action) |
| `alerts.js` | Telegram alerts for the troves people follow: compares each with the state last reported for it and sends what changed; also the daily, weekly or monthly summaries (`/digest`) |
| `api/telegram.js` | Vercel function: the webhook of @BoldbotAlertsBot (follow a trove, `/status`, `/safe`, `/digest`, `/list`, `/stop`, `/help`) |
| `api/_view.js` | Shared by the bot and the summaries: queue position, colour band, collateral ratio, liquidation price and the lowest rate to stay in the green (not an endpoint: the underscore keeps Vercel from serving it) |
| `telegram-setup.js` | One-time setup: registers the bot's webhook and command menu with Telegram (`--check` shows them) |
| `public/index.html` | The page: the Redemptions, Troves and Methodology tabs |
| `public/eth_drawdowns.json` | How often ETH fell by 1–95% within 7 or 30 days (Coinbase, May 2025 – October 2026), for the liquidation context; a static table made from Coinbase ETH-USD minute prices by a separate research script, not part of this repo |

The trove snapshot runs after every sync, separately from it: if it fails, the redemption data is not affected and the
previous snapshot is kept. It is published as `troves.json` (the snapshot) and `trovehits.json` (every redemption hit, for
the troves' and managers' records), served at `/api/troves` and `/api/trovehits` by the local server. The trove operations
follow, also separately (a failure keeps those already stored), and are published as `troveops.json`: for each trove of the
snapshot, BOLD borrowed and repaid and collateral added and withdrawn per week, and the last 30 days, for the borrowing
record, the weekly chart of BOLD redeemed against borrowed and the "refills" tag (served at `/api/troveops`).

## Telegram alerts

[@BoldbotAlertsBot](https://t.me/BoldbotAlertsBot) sends alerts about any trove someone follows: a self-managed trove being redeemed
against, a batch in front of a self-managed trove moving its rate above it, redemptions hitting the batch of a trove, the batch manager changing the rate,
and a trove joining or leaving a batch, becoming a zombie or closing. People follow a trove with the **Alerts on Telegram**
button in its detail on the Troves tab.

- **Following**: the button opens the bot with a start code for the trove. Telegram sends the message to the Vercel
  function `api/telegram.js` (webhook protected by a secret), which stores the subscription in Upstash Redis and answers.
- **Alerts**: after each trove snapshot, `alerts.js` compares every followed trove with the state last reported for it
  (also in Upstash) and sends what changed, so each change is reported once even if a run is repeated. Alerts therefore
  arrive up to about 30 minutes after a change. The queue figures follow the page's rules.
- **Commands**: `/status` (the state of the followed troves: a button per trove, or all), `/safe` (the lowest rate to stay
  in the green on each branch and for each followed trove, with how concentrated that protection is), `/digest` (a daily,
  weekly or monthly summary, sent by `alerts.js` at 08:00 UTC), `/list`, `/stop`, `/help`. `/status` and `/safe` read the
  published `troves.json`, which carries the typical and busiest week of redemptions (`weeks`) so their colour bands match
  the alerts.
- **Storage** (Upstash Redis, free tier): `watched` (followed troves), `watchers:<trove>` and `subs:<chat>` (who follows
  what), `state:<trove>` (last reported state), `digests`, `digest:<chat>` and `dstate:<chat>` (summary choice and the state
  at the last summary). Nothing about subscribers is published in this repo.
- **Settings**: GitHub secrets `TELEGRAM_BOT_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` (for the job); Vercel
  environment variables `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and the `KV_…` variables added by the Upstash
  integration (for the function). Without them the job runs as before and sends nothing.
- **Setup**, once after the function is deployed, and again when the command menu changes: `node telegram-setup.js`
  (needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in `.env`).

Redemptions are found through BOLD burns: every redemption burns the redeemed BOLD, and Alchemy's
transfers API lists those burns over any block range (its free tier limits `eth_getLogs` to 10
blocks). Each burn's receipt is then checked for `Redemption` events. Completeness can be checked
against the CollateralRegistry's `lastFeeOperationTime`, which only redemptions update.
