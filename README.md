# Delivery Surge Scanner

See [CLAUDE.md](CLAUDE.md) for the full spec and [DATA_SOURCES.md](DATA_SOURCES.md)
for the exact NSE/BSE URLs this project depends on and the reasoning behind
the two-database setup below.

## Two databases, on purpose

Neon's free tier caps out at 512MB — the full NSE+BSE universe doesn't fit.
So there are two Postgres instances:

- **Local Postgres** (`LOCAL_DATABASE_URL`) — the full raw archive, every
  symbol/series, no filtering. Your own machine only; nothing else can reach it.
- **Neon** (`DATABASE_URL`) — only symbols meeting CLAUDE.md §4.3's liquidity
  bar (20-day median turnover ≥ ₹1cr by default). This is what the deployed
  app and the GitHub Actions daily job read/write.

## Setup

1. Install a local Postgres server (see below if `winget`/the usual installer
   is blocked in your environment) and create a database, e.g. `strat`.
2. Copy `.env.example` to `.env`, set `DATABASE_URL` to your Neon connection
   string and `LOCAL_DATABASE_URL` to your local Postgres connection string.
3. `npm install`
4. Push the schema to **both** databases. **Note:** if your network blocks
   outbound TCP on port 5432 to remote hosts (common on corporate networks —
   this happened during development, though loopback to a local server is
   unaffected), `drizzle-kit migrate`/`push` against Neon will hang, because
   it uses a raw Postgres driver. In that case, generate the SQL once and
   apply it over Neon's HTTP driver:
   ```bash
   npm run db:generate
   npm run db:apply -- drizzle/<generated-file>.sql          # Neon
   ```
   Local Postgres has no such restriction — `npx drizzle-kit migrate` (pointed
   at `LOCAL_DATABASE_URL`) works directly, or reuse `db:apply` against it too.

### If the normal PostgreSQL installer is blocked

In this project's dev environment, `winget install PostgreSQL.PostgreSQL.17`
failed with a 403 from EnterpriseDB's installer CDN, and even after
downloading the installer directly, the GUI installer produced no logs and
never actually ran (likely blocked as an unsigned/downloaded executable in a
non-interactive session). The **portable binaries ZIP** (no installer)
worked instead:
1. Download `postgresql-<version>-windows-x64-binaries.zip` from
   `https://get.enterprisedb.com/postgresql/`.
2. Extract it, then initialize and start a server from its `pgsql/bin` folder
   (`initdb`, then `pg_ctl start`) pointed at a data directory of your choice.

## Backfill (local — the full archive)

```bash
npm run backfill -- --exchange NSE --from 2021-09-21 --to 2026-09-18
npm run backfill -- --exchange BSE --from 2021-09-21 --to 2026-09-18
```

Defaults to `--db local`. Resumable: re-running the same command skips any
(exchange, date) already recorded as `success` or `no_data` in
`ingestion_log`. If a run is interrupted or a specific date fails, just run
the same command again — only the remaining/failed dates are retried.

NSE first, then BSE, per CLAUDE.md — confirm NSE data looks right before
spending the time on the BSE run.

## Promoting liquid symbols to Neon

After a local backfill, decide which symbols are liquid enough to live in
Neon (and copy their full history there):

```bash
npm run compute-universe -- --exchange NSE
npm run compute-universe -- --exchange BSE
```

Re-run this periodically (there's no automated schedule for it — it needs
local data, which GitHub Actions can't reach) to pick up newly-liquid
symbols. Add `--prune` to also delete Neon `daily_bars` for symbols that no
longer qualify, if you need to reclaim space.

To backfill a longer history directly into Neon for symbols already flagged
liquid there (skipping local entirely), use `--db neon`:
```bash
npm run backfill -- --exchange NSE --from 2021-09-21 --db neon
```

## Daily ingestion

`npm run ingest:daily` ingests one date (today by default, or `-- --date YYYY-MM-DD`)
for both exchanges, writing **only to Neon**, filtered to whatever's already
flagged liquid there. This is what `.github/workflows/daily-ingest.yml` runs
on a schedule (14:00 UTC / 19:30 IST, weekdays) — set the `DATABASE_URL`
secret in the GitHub repo settings for it to work. It cannot and does not
touch local Postgres.

## Corporate action detection

```bash
npm run detect-actions -- --exchange NSE       # runs against local by default
npm run detect-actions -- --exchange NSE --db neon
```

Unconfirmed detections still get applied (CLAUDE.md §6.3) — review them at
`/admin` (confirm, correct the ratio/type, reject, or add one manually).

## Running the app locally

```bash
npm run dev
```

Opens on `http://localhost:3000`. This is a stock Next.js app — reads from
Neon only (`db/index.ts`), never touches local Postgres. Symbol pages, the
strategy editor, backtests, and Admin all work against whatever's currently
in Neon (i.e. the liquid subset, once you've run `compute-universe` at least
once).

## Deployment

Per CLAUDE.md §12 — Vercel does no heavy lifting; ingestion and scanning
always happen elsewhere (GitHub Actions, or your own machine).

1. **Neon**: already provisioned if you've gotten this far — copy its
   connection string for the next steps.
2. **Vercel**: `vercel deploy` from the repo root. No custom build config, no
   edge functions — this is deliberately a stock Next.js app. Set
   `DATABASE_URL` in the Vercel project's environment variables (Neon's
   connection string). Optionally set `ADMIN_PASSWORD` to gate `/admin`
   behind HTTP Basic Auth (see `middleware.ts`) — recommended once deployed,
   since Admin can confirm/reject corporate actions and trigger scans.
3. **GitHub Actions**: push this repo to GitHub, then add `DATABASE_URL` as a
   repository secret (Settings → Secrets and variables → Actions). The
   `daily-ingest.yml` workflow runs weekdays at 14:00 UTC (19:30 IST):
   ingest, then scan (per CLAUDE.md §12 point 6) — both against Neon only.
   You can also trigger it manually via the Actions tab (`workflow_dispatch`).
4. The **Admin scan-trigger button** (`/admin`) is a local-dev convenience
   only — it runs the scan in-process and can take ~an hour, which exceeds
   any serverless function's timeout. Don't rely on it once deployed; use
   the GitHub Actions workflow (scheduled or manually dispatched) instead.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | app, GitHub Actions, local scripts | Neon — liquid-universe subset only |
| `LOCAL_DATABASE_URL` | local scripts only | Full raw archive, this machine only |
| `ADMIN_PASSWORD` | app (Vercel) | Optional. Gates `/admin` via HTTP Basic Auth — unset locally is fine (no-op) |

## Project layout

- `db/schema.ts` — Drizzle schema, shared by both databases
- `db/neon.ts` (exported as `db` from `db/index.ts`) — Neon client, HTTP driver
- `db/local.ts` (`localDb`) — local Postgres client, standard TCP driver
- `lib/ingest/` — fetch/parse functions for NSE and BSE, the upsert layer, and
  `filterToLiquidUniverse` (the liquid-subset gate)
- `scripts/backfill.ts` — resumable historical backfill CLI (`--db local|neon`)
- `scripts/ingest-daily.ts` — one-date incremental ingestion, run by GitHub Actions (Neon only)
- `scripts/compute-liquid-universe.ts` — decides + syncs the liquid subset, promotes history to Neon
- `scripts/detect-corporate-actions.ts` — corporate action detection (`--db local|neon`)
- `scripts/spike/` — throwaway Phase 1 scripts that confirmed the data sources; not used by the app
- `.github/workflows/daily-ingest.yml` — scheduled daily ingestion + scan
- `middleware.ts` — gates `/admin` behind `ADMIN_PASSWORD` if set
- `app/`, `components/`, `lib/queries/`, `lib/engine/` — the dashboard, symbol detail, strategy editor, backtest, and admin pages, and the pure analysis engine they all share
