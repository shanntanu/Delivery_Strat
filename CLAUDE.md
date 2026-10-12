# CLAUDE.md — Delivery Surge Scanner (NSE + BSE)

Business requirements and technical spec. This file is the source of truth for the project. Claude Code should read it before any task and keep it updated as decisions change.

---

## 1. Purpose

Indian exchanges publish, for every stock every day, how much of the traded volume resulted in actual delivery (shares moving between demat accounts) rather than intraday squaring off. A sustained rise in delivery quantity, accompanied by a rising price, is a plausible fingerprint of accumulation by someone with a multi-day horizon.

This tool scans the full NSE and BSE equity universe for that fingerprint, quantifies how the stock behaved historically after each occurrence, stores an editable per-symbol strategy, and lets the user backtest it.

**What this tool is not:** it is not an advisory product, it does not place orders, and it does not predict. It measures a historical tendency on a small sample and presents it honestly, including when the evidence is weak.

---

## 2. The pattern being detected

Derived from a study of BECTORFOOD daily data, 21-Sep-2021 to 18-Sep-2026 (1,240 sessions).

### 2.1 Definition

A **signal** occurs on day *t* when all of the following hold over the window of days *t-3 … t*:

| Condition | Default |
|---|---|
| Baseline delivery = median delivery quantity over days *t-23 … t-4* | 20-day median |
| Every day in the window has `delivery / baseline ≥ min_ratio` | 1.3 |
| Window mean of `delivery / baseline` falls between `avg_ratio_min` and `avg_ratio_max` | 1.5 to 3.5 |
| Window mean of `trades / trades_baseline ≥ trades_ratio` | 1.3 |
| Cumulative price change over the window between `price_min` and `price_max` | +3% to +12% |
| Count of up-days in window `≥ min_up_days` | 3 of 4 |
| Close above 20-DMA and 50-DMA | true |

Entry: **open of day t+1**. Exit: **close of day t+10** (10 trading days), or stop-loss at **7%** below entry, whichever comes first.

### 2.2 Why each rule exists

- **Median baseline, not mean.** A single prior spike would otherwise inflate the baseline and hide the next genuine surge.
- **Every day must clear `min_ratio`.** This is what separates *sustained* interest from one violent day. It is the core of the pattern.
- **`avg_ratio` has an upper bound.** Counter-intuitive but empirical: in the source study, the 2–3× bucket returned +6.8% over 10 days with an 88% win rate, while the 3–5× bucket returned +1.8%. Extreme surges are more often news events, bulk deals, or blow-off tops than accumulation. Do not "improve" this by removing the cap.
- **Price must rise.** Delivery quantity counts both the buyer and the seller of the same shares. It says *conviction*, not *direction*. Price is the only available disambiguator between accumulation and distribution. In the source study, price-up windows won 83% over 10 days versus 59% for price-down.
- **Price must not rise too much.** Windows where the price had already run >12–15% showed a degraded forward edge and deeper drawdowns.
- **10-day hold, not 5.** The 5-day forward return averaged only +1.1% with a 57% win rate; the edge materialised over ~10 sessions.
- **7% stop, not 4%.** Mean adverse excursion after entry was −3.4%. Tight 4–5% stops cut the 10-day average from +5.3% to +3.3%, i.e. they stopped out of eventual winners.

### 2.3 Explicitly rejected patterns

Do not build features around these; they were tested and failed:

- **Single-day delivery spike.** Delivery ≥5× normal with price ≥+2%: 9 occurrences, 10-day average **−3.2%**, win rate 33%, mean drawdown −8.4%.
- **Delivery % of volume as a filter.** High vs low `%DlyQt` made no meaningful difference to forward returns. Store it, display it, don't gate on it.
- **5-day windows.** Weaker than 4-day (10-day average ~+3% vs +5.3%).

### 2.4 Honest baseline for the source study

14 signals over 5 years on one stock. 10-day forward: mean +5.3%, **median +2.0%**, 12/14 positive, worst −4.2%. Random-day baseline: mean +0.9%, 50% positive. Permutation p ≈ 0.01 before accounting for the ~600 parameter combinations tested. 12 of 14 signals fell in the 2022–24 uptrend. The robust findings are directional (price-up beats price-down; sustained beats spiky); the exact percentages are not.

**Every part of the UI that reports performance must carry this character of uncertainty forward.** See §10.

---

## 3. Architecture

```
┌──────────────────┐     ┌───────────────┐     ┌────────────────┐
│ GitHub Actions   │────▶│  Postgres     │◀────│  Next.js app   │
│ daily ingestion  │     │  (Neon)       │     │  on Vercel     │
│ + local backfill │     │               │     │  (read mostly) │
└──────────────────┘     └───────────────┘     └────────────────┘
```

**Why ingestion is not on Vercel:** NSE and BSE frequently block cloud datacenter IPs and require browser-like headers plus a cookie warm-up. A 5-year backfill (~1,240 files per exchange) also exceeds any serverless timeout. GitHub Actions runners have residential-ish reputation and no practical time limit, and running the backfill locally is trivial. This split also means the Vercel side is a stock Next.js app with no custom runtime config — which is the whole point of the "easy deployment" requirement.

**Decision update (2026-09-22): two databases, not one.** Neon's free tier
caps a project at 512MB. The full NSE backfill alone (~2.4M rows, all EQ
symbols + ETFs) used 476MB, leaving no room for BSE's larger universe — the
BSE backfill failed on ~560/1304 dates with a "project size limit exceeded"
error. Rather than upgrade to a paid Neon plan or shrink the backfill window,
storage is now split:

- **Local Postgres**, this machine only: the full raw archive, every
  symbol/series in NSE + BSE, unfiltered. Source of truth for offline research.
- **Neon**: only symbols meeting §4.3's liquidity bar (20-day median turnover
  ≥ ₹1cr by default), computed from local data and flagged via a new
  `symbols.is_scan_universe` column. This is what the deployed app and the
  GitHub Actions daily job actually read/write — neither has any network path
  to the local database, so GitHub Actions' daily ingestion writes directly
  to Neon, filtered to whatever's already flagged there, and a separate local
  script (`scripts/compute-liquid-universe.ts`) periodically recomputes the
  liquid set and promotes newly-qualifying symbols' full history to Neon.

This means the scan universe (§4.3) is no longer just a query-time filter —
it now also gates what data physically exists in Neon. See DATA_SOURCES.md
and README.md for the operational details.

**Decision update (2026-09-23): plain Tailwind, not shadcn/ui.** All of
Phase 6's pages (§10.1–§10.5) shipped as plain Tailwind utility classes with
hand-written components, not shadcn/ui's generated component set. Nothing
in the UI needed shadcn's specific primitives (its component set is mostly
useful for things like dialogs, comboboxes, and form-kit patterns this app
doesn't have), and by the time this was noticed the pages were already
built, tested against real data, and working — retrofitting shadcn in would
mean re-scaffolding working components for a styling-system change with no
user-facing benefit. Not revisited unless a future page genuinely needs a
primitive shadcn provides that plain Tailwind makes awkward.

### 3.1 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15, App Router, TypeScript | One deploy target, server components keep the client thin |
| Styling | Tailwind (plain utility classes) | See decision note below |
| Charts | Recharts | Adequate for equity curves and price/delivery overlays |
| DB | Postgres on Neon (serverless, free tier) | Branching, scales to zero, works with Vercel out of the box |
| ORM | Drizzle | Typed, lightweight, good migrations |
| Tables | TanStack Table | Sorting/filtering the universe list |
| Ingestion | Node scripts run by GitHub Actions | Same language as the app |
| Tests | Vitest | Fast, zero config |

No Redis, no queue, no auth service, no separate Python worker.

---

## 4. Data sources

> **These URLs are from the author's notes and change frequently. Verify them in Phase 1 before building on them, and record what actually worked in `DATA_SOURCES.md` with the date.**

### 4.1 NSE

Two candidate paths; check which is live:

- Combined file with delivery columns: `sec_bhavdata_full_DDMMYYYY.csv` under the NSE archives. Columns of interest include symbol, series, date, prev close, OHLC, last, close, VWAP, total traded quantity, turnover, number of trades, deliverable quantity, and delivery percentage.
- If the combined file is unavailable, NSE has historically published price data and delivery data separately — the delivery-side file is the MTO (market-to-order / delivery position) daily file, which must be joined to the price bhavcopy on symbol + series.

NSE requires a session cookie. Fetch the homepage first with a realistic `User-Agent`, `Accept-Language`, and `Referer`, keep the cookie jar, then request the archive file. Expect throttling; rate-limit to roughly one request per 1.5–2 seconds and retry with exponential backoff.

Filter to `series = 'EQ'`. Other series (BE, BZ, SM, ST) have different trading rules and should be excluded from the default universe, though the schema should retain the series column.

### 4.2 BSE

BSE publishes an equity bhavcopy and a separate gross delivery file per day, joined on scrip code. BSE scrip codes are numeric and differ from NSE symbols — maintain an ISIN-based mapping table so the same company is not scanned twice under two identities.

### 4.3 Universe scope and cost

Roughly 2,000 NSE EQ symbols and 4,000+ BSE scrips × ~1,240 sessions ≈ 7–8 million rows. This is comfortable for Postgres with proper indexing but the backfill will take hours. Design for resumability: record each completed date per exchange in an `ingestion_log` table and skip it on re-run.

**Default the scan universe to NSE EQ symbols with a 20-day median turnover above ₹1 crore.** Illiquid scrips generate meaningless ratios (a stock delivering 400 shares normally will trip a 1.3× filter on noise) and they dominate the universe by count. Make the liquidity threshold configurable.

---

## 5. Database schema

```
symbols
  id, exchange ('NSE'|'BSE'), symbol, isin, name, series,
  is_active, first_seen, last_seen
  unique (exchange, symbol, series)

daily_bars
  symbol_id, date,
  prev_close, open, high, low, last, close, vwap,
  volume, turnover, trades, delivery_qty, delivery_pct
  primary key (symbol_id, date)
  index on (date)

corporate_actions
  id, symbol_id, ex_date, type ('split'|'bonus'|'consolidation'),
  ratio_numerator, ratio_denominator, adj_factor,
  source ('detected'|'manual'), confirmed boolean, notes

strategies
  id, symbol_id, name, is_default, is_active,
  params jsonb,            -- see §7
  tuning jsonb,            -- p-value, oos split results, grid searched, signal count
  created_at, updated_at
  index on (symbol_id)

signals
  id, symbol_id, strategy_id, signal_date,
  window_start, window_end,
  avg_ratio, min_ratio, trades_ratio, price_change_pct,
  up_days, avg_delivery_pct, baseline_delivery, baseline_trades,
  entry_price, fwd_1, fwd_3, fwd_5, fwd_10, fwd_20,
  mfe_10, mae_10, exit_reason, realized_return
  index on (symbol_id, signal_date)

scan_runs
  id, started_at, finished_at, universe_size, symbols_with_signals,
  params_snapshot jsonb, status, error

backtests
  id, symbol_id, strategy_id, run_at,
  params jsonb, metrics jsonb, equity_curve jsonb, trades jsonb

ingestion_log
  exchange, date, status, rows_ingested, error, completed_at
  primary key (exchange, date)
```

---

## 6. Corporate action adjustment — critical

Neither exchange adjusts historical bhavcopy data for splits and bonuses. **If this is not handled, every ratio in the system is silently wrong.**

Concrete example from the source data: BECTORFOOD did a 5:1 split effective 12-Dec-2025. Raw data shows the price dropping from 1310 to 271 overnight and the pre-split delivery quantities being 5× smaller than they should be in post-split terms. Unadjusted, the tool would read this as a −79% crash plus a permanent delivery surge, and would corrupt every baseline spanning the date.

### 6.1 Detection

Flag a candidate corporate action when `prev_close / close_of_previous_session` deviates from 1.0 by more than 2%. The `prev_close` field in the bhavcopy is the exchange's own adjusted figure, so this discontinuity is a reliable detector. Infer the ratio from the jump and snap it to the nearest sensible fraction (1:2, 1:5, 1:10, 2:1, 3:1...).

### 6.2 Application

Store raw bars untouched, forever. Apply adjustment in a derived view or in the engine's data loader:

- Prices before the ex-date: **divide** by the adjustment factor.
- Volume and delivery quantity before the ex-date: **multiply** by the factor.
- Turnover, trade count, and delivery percentage: **unchanged** — these are already ratio- or currency-denominated and do not scale with share count. Getting this wrong is a common and subtle bug.

### 6.3 Human confirmation

Auto-detection will produce false positives on genuine one-day crashes and on illiquid scrips. Surface detected actions in an admin page with the raw before/after bars shown, let the user confirm, correct, or reject each one, and let them add actions manually. Unconfirmed detections should still be applied (better than nothing) but flagged in the UI on any symbol that relies on them.

---

## 7. Strategy object

Stored as `jsonb` in `strategies.params`, versioned by a `schema_version` field.

```jsonc
{
  "schema_version": 1,
  "window_days": 4,
  "baseline": {
    "lookback_days": 20,
    "method": "median",          // "median" | "mean"
    "exclude_window": true       // baseline computed strictly before the window
  },
  "delivery": {
    "min_ratio_each_day": 1.3,
    "avg_ratio_min": 1.5,
    "avg_ratio_max": 3.5
  },
  "trades": {
    "min_avg_ratio": 1.3,
    "enabled": true
  },
  "price": {
    "cum_change_min_pct": 3,
    "cum_change_max_pct": 12,
    "min_up_days": 3,
    "require_above_sma": [20, 50]
  },
  "filters": {
    "min_delivery_pct": null,    // null = disabled; see §2.3
    "min_avg_turnover_cr": 1.0
  },
  "execution": {
    "entry": "next_open",        // "next_open" | "signal_close"
    "hold_days": 10,
    "stop_loss_pct": 7,
    "target_pct": null,          // null = no target; targets capped upside in testing
    "trailing_stop_pct": null,
    "cooldown_days": 10          // suppress a new signal within N days of the last
  },
  "costs": {
    "brokerage_bps": 3,
    "slippage_bps": 15,
    "include_stt": true
  }
}
```

Every field must be editable in the UI. Every field must have a tooltip explaining what it does and, where relevant, what the source study found about it — so the user is editing with context rather than guessing.

---

## 8. Analysis engine

Located in `lib/engine/`. **Pure functions. No database access, no network, no clock reads.** Input: an array of adjusted bars plus a params object. Output: signals, trades, metrics. This makes it trivially testable and lets the same code serve the scanner, the backtester, and the UI preview.

### 8.1 Modules

- `baseline.ts` — rolling median/mean of delivery and trades, strictly excluding the window under evaluation.
- `detect.ts` — window evaluation, returns signals with all component ratios attached for display.
- `simulate.ts` — walks each signal forward bar by bar, applying stop, target, trailing stop, and time exit in that priority order within each day. When a bar's high and low would both trigger, assume the **worse** outcome (stop before target); silent optimism here is how backtests lie.
- `metrics.ts` — the statistics in §8.2.
- `tune.ts` — the grid search in §9.

### 8.2 Metrics computed for every backtest

Count of signals. Mean and **median** return. Win rate. Best and worst trade. Profit factor. Mean MFE and MAE over the hold. Average bars held. Maximum consecutive losses. Equity curve assuming fixed position size. Return distribution by year. Comparison against a same-count random-entry baseline. Permutation test p-value (≥5,000 iterations of random entry dates drawn from the same symbol's history). Results split by the first 70% and last 30% of history.

---

## 9. Per-symbol tuner

After the scan, optionally tune parameters per symbol. This is the feature most likely to produce self-deception, so it is deliberately constrained.

### 9.1 Constraints

- Search a **fixed small grid**, not a continuous optimiser:
  - `window_days`: 3, 4, 5
  - `min_ratio_each_day`: 1.2, 1.3, 1.5
  - `avg_ratio_min`: 1.5, 2.0
  - `cum_change_min_pct`: 0, 3, 5
  - `hold_days`: 5, 10, 20
  - Everything else fixed at default.
- **Refuse to emit a strategy if the best cell yields fewer than 8 signals.** Write `"no_reliable_pattern"` against the symbol instead and show it that way in the UI.
- Rank cells by **median** 10-day return, not mean, with win rate as tiebreaker. Ranking by mean selects for one lucky outlier.
- Tune on the first 70% of history; record untouched last-30% performance alongside. Flag any strategy where the sign flips between the two.
- Store the number of combinations searched in `tuning`, and surface it in the UI next to the p-value, because a p-value from a 162-cell search means much less than one from a single hypothesis.

### 9.2 What the user sees

Tuned strategies are badged distinctly from default strategies. The detail page shows default-params performance and tuned performance side by side, so the user can judge how much of the improvement is real.

### 9.3 Implementation note (added 2026-09-23, wiring the tuner into persistence)

This section doesn't fully specify how "tuning a symbol" maps onto the schema — recorded here since it's a non-obvious decision, per §14's standing note to update this file rather than leave it implicit:

There is exactly one strategy row per symbol with `is_default = true` (enforced by `strategies_one_default_per_symbol`, §5/§6-adjacent history). Tuning does **not** create a second row. `lib/tuner-runner.ts` overwrites that row's `params` with the best grid cell found, renames it `"Tuned"`, and records the full diagnostic trail (p-value, OOS train/test medians and signal counts, sign-flip flag, combinations searched) in its `tuning` jsonb column. If no cell clears the ≥8-signal bar, the row is left at (or reverted to) `DEFAULT_STRATEGY_PARAMS` named `"Default"`, with `tuning.status = "no_reliable_pattern"` — so a symbol that stops qualifying on a later re-tune correctly falls back instead of keeping stale tuned params forever. Either way, the symbol's persisted `signals` are recomputed for whichever params are now current (`lib/signal-persistence.ts`), so the dashboard/symbol-detail/backtest queries — which all just read "the default strategy" — see consistent results without needing separate tuned-strategy plumbing.

The p-value surfaced on the dashboard badge (§10.1) is computed against the **full** history under the tuned params (≥5,000 permutations per §8.2), not just the training split — it answers "is this pattern real for this symbol", which `oosSignFlip`/`oosAgrees` (train-vs-test sign agreement) already covers separately.

§9.2's "side by side" comparison is computed **live** on the symbol detail page (`lib/queries/symbol-detail.ts`), not persisted: bars are already loaded for the chart, so re-running the pure engine with `DEFAULT_STRATEGY_PARAMS` for comparison is cheap and always consistent with what's actually stored, with no second copy to keep in sync.

Run via `npm run tune -- --exchange NSE`, the `/admin` tuner-trigger button (dev-time only, same caveats as the scan trigger), or `.github/workflows/weekly-tune.yml` (see §12 point 4 for why weekly, not daily).

---

## 10. UI

### 10.1 Dashboard (`/`)

Table of every symbol the scan has evaluated, with: symbol, name, exchange, last scan date, signal count, median 10-day return, win rate, current status (`active signal` / `in trade` / `watching` / `no pattern`), and a reliability badge.

Reliability badge: green when signals ≥ 12 and p < 0.05 and OOS agrees; amber when signals 8–11 or p between 0.05 and 0.15; red/grey when below the threshold or OOS disagrees. Default sort puts green first, and **the default filter hides "no pattern" symbols** so the list is a shortlist rather than a universe dump.

Header strip: last ingestion date, universe size, number of symbols with active signals today, last scan run status.

### 10.2 Symbol detail (`/symbol/[exchange]/[symbol]`)

Reproduces the analysis shown for BECTORFOOD in the source study:

1. **Header** — name, exchange, last close, last-day delivery vs baseline, current setup status.
2. **Data quality notice** — any corporate actions applied, whether they were auto-detected or confirmed, the date range covered, and any gaps. This sits above the results, not buried at the bottom.
3. **Signals table** — every historical signal with signal date, the four component ratios, cumulative window price change, and forward returns at 5/10/20 days. Clicking a row highlights that window on the chart.
4. **Summary statistics** — mean *and* median forward returns, win rate, drawdown, versus random baseline, p-value, combinations searched, and the OOS split.
5. **Chart** — price candles with signal windows shaded, delivery quantity as a secondary panel with the rolling baseline overlaid, and entry/exit markers.
6. **What didn't work** — for this symbol, the single-day-spike result and the price-down-window result, so the user sees the contrast that justifies the filters rather than taking it on faith.
7. **Current parameters card** — the strategy in the format of the source study's table, with an Edit button.

### 10.3 Strategy editor (`/symbol/.../strategy`)

Form over the §7 schema, grouped by section, with tooltips. Live preview: as the user changes a parameter, re-run the engine client-side or via a server action and show the updated signal count and median return immediately, before saving. Save creates a new row rather than mutating, so strategy history is retained and revertible. Reset-to-default is always one click away.

### 10.4 Backtest (`/symbol/.../backtest`)

Date range selector, strategy selector (default / tuned / any saved custom), and a run button. Output: metrics panel, equity curve, trade list with entry, exit, exit reason, return, and bars held, plus per-year breakdown. Two strategies can be compared side by side.

Costs are **on by default**. A backtest that ignores brokerage, STT, and slippage on a 10-day hold is not a useful number.

### 10.5 Admin (`/admin`)

Ingestion status by date, corporate action review queue, scan trigger, universe filter settings.

---

## 11. Testing

Create a golden fixture: the BECTORFOOD CSV used in the source study, committed to `fixtures/`. The engine must reproduce the study's numbers from it. Specifically, with default parameters and the 5:1 split on 12-Dec-2025 applied, it should find **14 signals** with a mean 10-day forward return near **+5.3%** and a median near **+2.0%**.

If the implementation produces materially different numbers, something is wrong — most likely the split adjustment, the baseline exclusion window, or an off-by-one in the forward return. Do not adjust the fixture expectations to match the code.

Additional required tests:

- Split adjustment: prices divided, quantities multiplied, turnover and delivery-percentage untouched.
- Baseline never includes any day inside the window it is evaluating.
- Entry price equals the open of the day after the signal, never the signal day's close.
- Stop-and-target-same-day resolves pessimistically.
- Cooldown suppresses clustered signals correctly.
- Engine returns empty rather than throwing on short history, all-zero delivery, or missing days.

---

## 12. Deployment

1. Provision Neon Postgres, copy the connection string.
2. `DATABASE_URL` into Vercel env and into GitHub Actions secrets.
3. `npx drizzle-kit push` to create the schema.
4. Locally: `npm run backfill -- --exchange NSE --from 2021-09-21` (expect several hours).
5. `vercel deploy`. No custom build config, no serverless tuning, no edge functions.
6. Enable the GitHub Actions workflow for daily ingestion at 19:30 IST (14:00 UTC), followed by the scan. Enable `weekly-tune.yml` separately (weekly, not daily — see point 8).
7. Protect write endpoints with an env-var shared secret; use Vercel's built-in password protection for the whole app if desired.
8. **Actions-minutes budget, if the repo is private.** A private GitHub repo gets 2,000 free Actions minutes/month. The daily scan alone was estimated at ~1,600-1,800 min/month before `lib/scan-runner.ts` was parallelized (§9.3-adjacent — 6 symbols concurrently, since Neon's HTTP driver has no per-connection state to protect); the tuner's weekly cadence (rather than daily) exists specifically so it doesn't compound this. If the repo is public, Actions minutes are unmetered and this constraint doesn't apply.
9. `scripts/compute-liquid-universe.ts` can only run locally (needs the full local archive) and has no fixed schedule — nothing else can trigger it. Since 2026-09-23 it records a `scan_runs(run_type='universe')` row in Neon on completion, so `/admin` can show when it last ran and warn if it's gone stale (>30 days, a judgment call, not a derived threshold). Re-run it periodically; there's no way to automate this away without giving GitHub Actions access to the local archive, which defeats the reason it isn't there.

10. **Ingestion is self-healing (2026-10-12).** `scripts/ingest-daily.ts` ingests every weekday since the last success that isn't resolved in `ingestion_log` (retrying `failed` dates and `no_data` dates from the last 3 days, since "no file" can just mean not yet published), instead of only "today". The original today-only design could never recover a missed day, and Neon sat stale at 18-Sep after the first scheduled runs failed. The daily workflow also now runs `detect-actions --db neon --since-days 10` between ingest and scan, because ingesting without detection leaves splits unadjusted (§6). Every script that Actions runs must load `db/local.ts` lazily — it throws when `LOCAL_DATABASE_URL` is unset, which broke the first `tune`/`scan` runs on GitHub. Ingest is NSE-only by default (§13); BSE via `--exchange BSE`.

Vercel free tier is sufficient because Vercel does no heavy lifting — all computation happens either in GitHub Actions or inside a short server action against pre-computed data.

---

## 13. Scope boundaries

**Decision update (2026-09-22): BSE paused, NSE-only for now.** The user
chose to defer BSE entirely — no BSE backfill, no BSE scanning, no BSE in
the dashboard, until further notice. All BSE code (`lib/ingest/bse.ts`,
`--exchange BSE` flags throughout the scripts, the BSE fetch/parse/join
logic) stays in place, untouched, for when this is picked back up — it is
not being deleted or deprioritized as dead code, just not run right now.
New work (Phase 5 scanning, Phase 6 dashboard, etc.) should default to NSE
and treat BSE support as already-built-but-dormant rather than missing.

**In scope:** NSE and BSE cash equities, end-of-day delivery data, the pattern in §2, per-symbol strategies, backtesting, the dashboard. (BSE currently paused — see decision above.)

**Out of scope for v1:** intraday data, F&O, bulk/block deal data, FII/DII flows, shareholding pattern changes, order placement, broker integration, alerts and notifications, multi-user accounts, portfolio tracking, mobile app.

**Deliberately excluded:** anything that presents a backtest result as a prediction, any "confidence score" that compresses the uncertainty in §2.4 into a single reassuring number, and any default view that hides the sample size.

---

## 14. Standing notes for Claude Code

- Ask rather than assume, particularly about data formats and corporate actions.
- When a result looks too good, check for look-ahead bias before celebrating it.
- Keep the engine pure and the I/O at the edges.
- Update this file when a decision changes; a stale spec is worse than none.
- The user is aware this is a small-sample, single-stock-derived pattern. Build the tool to keep him aware of that too, rather than to make him forget it.
