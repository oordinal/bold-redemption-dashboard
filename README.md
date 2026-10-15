# BOLD Redemption Dashboard

Tracks every redemption of Liquity V2's BOLD stablecoin on Ethereum mainnet and measures what the
redeemers actually made: BOLD discount, oracle gap, redemption fee, gas, builder tips and net profit.
The **How it works** tab explains the redemption mechanics and the methodology.

## Run locally

Requires Node 20+ and an [Alchemy](https://www.alchemy.com/) API key (the free tier is enough).

```bash
cp .env.example .env        # then put your key in ALCHEMY_API_KEY
npm install
npm start                   # http://localhost:3000
```

The first start syncs every redemption since the V2 launch (about 15 minutes); after that the server
syncs new blocks every 5 minutes and the **Sync now** button triggers one on demand.

## How the hosted version works

Vercel only serves static files, so the data is produced elsewhere:

1. `.github/workflows/sync.yml` runs every 30 minutes (and on demand from the Actions tab). It restores
   the SQLite database from the `data` branch, runs `node export.js out` to sync new redemptions,
   and force-pushes the JSON snapshot plus the database to `data` as a single commit.
2. Vercel serves `public/` and proxies `/data/*` to that branch (see `vercel.json`).
3. The page detects that there's no API and reads `data/*.json` instead.

Setup: add your Alchemy key as the repository secret `ALCHEMY_API_KEY`, run the workflow once, then
import the repository in Vercel with the default settings.

## Files

| File | Role |
|---|---|
| `worker.js` | Scans `Redemption` events, enriches each tx with prices and costs, writes SQLite |
| `queries.js` | The queries behind the feed, the leaderboard and the stats tiles |
| `index.js` | Local server: API, static files and the periodic sync |
| `export.js` | Sync, then write the static JSON snapshot (used by the GitHub Action) |
| `public/index.html` | The dashboard and the How it works tab |

Redemptions are found through BOLD burns: every redemption burns the redeemed BOLD, and Alchemy's
transfers API lists those burns over any block range (its free tier limits `eth_getLogs` to 10
blocks). Each burn's receipt is then checked for `Redemption` events. Completeness can be checked
against the CollateralRegistry's `lastFeeOperationTime`, which only redemptions update.
