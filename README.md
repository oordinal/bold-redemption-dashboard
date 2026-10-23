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
| `export.js` | Sync, trove snapshot, then write the static JSON snapshot (used by the GitHub Action) |
| `public/index.html` | The page: the Redemptions, Troves and Methodology tabs |
| `public/eth_drawdowns.json` | How often ETH fell by 1–95% within 7 or 30 days (Coinbase, May 2025 – October 2026), for the liquidation context; a static table made from Coinbase ETH-USD minute prices by a separate research script, not part of this repo |

The trove snapshot runs after every sync, separately from it: if it fails, the redemption data is not affected and the
previous snapshot is kept. It is published as `troves.json` (the snapshot) and `trovehits.json` (every redemption hit, for
the troves' and managers' records), served at `/api/troves` and `/api/trovehits` by the local server.

Redemptions are found through BOLD burns: every redemption burns the redeemed BOLD, and Alchemy's
transfers API lists those burns over any block range (its free tier limits `eth_getLogs` to 10
blocks). Each burn's receipt is then checked for `Redemption` events. Completeness can be checked
against the CollateralRegistry's `lastFeeOperationTime`, which only redemptions update.
