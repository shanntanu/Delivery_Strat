# Data Sources — confirmed working

Confirmed by running `scripts/spike/nse.ts` and `scripts/spike/bse.ts` on **2026-09-21**
against live data for the last trading day, **2026-09-18 (Friday)**.
Both exchanges change these URLs periodically — if ingestion starts failing,
re-run the spike scripts before assuming it's a code bug.

---

## NSE

**One combined file has everything** — price, volume, trades, and delivery — no join needed.

- **Warm-up**: `GET https://www.nseindia.com/` with a realistic `User-Agent` and
  `Accept-Language` header, then keep the `Set-Cookie` cookies (via
  `res.headers.getSetCookie()` in Node — plain `.get("set-cookie")` only returns one).
  A second warm-up hit on `https://www.nseindia.com/all-reports` (as `Referer`) was
  included but may not be strictly necessary; the homepage cookie alone let the
  archive request through in testing.
- **Data file**: `GET https://archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv`
  with the warm-up cookies attached and `Referer: https://www.nseindia.com/all-reports`.
  - `nsearchives.nseindia.com` (the CLAUDE.md-mentioned fallback CDN) was **not** needed —
    `archives.nseindia.com` (the original CLAUDE.md path) still works today.
  - Without any cookie/header warm-up, plain requests (e.g. bare `curl`) get a
    **403 from Akamai**, confirming the bot-blocking CLAUDE.md warns about.
- **Rate limit**: used ~1.8s between requests during testing; no throttling observed,
  but keep the 1.5–2s spacing per CLAUDE.md as a courtesy/precaution.
- **Format**: CSV, header row, columns:
  `SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER`
  (note the leading space in each column name after the first — trim on parse).
  Filter to `SERIES = ' EQ'` (also has a leading space).
- **Non-trading days**: not tested directly, but expect a 200 with an empty/error
  body or a 404 — verify during backfill implementation.

## BSE

**Two files, must be joined on scrip code** (BSE's `FinInstrmId` / `SCRIP CODE`,
numeric, e.g. `500002` = ABB). No cookie warm-up was needed for either file —
a `User-Agent` header alone was sufficient.

1. **Price bhavcopy** (SEBI Common Bhavcopy Format, CBFC — same new format NSE
   also has available but we didn't need for NSE since the combined file already works):
   `GET https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV`
   - Case-sensitive: uppercase `.CSV`, **not** zipped, despite the old CLAUDE.md notes
     assuming a zip. `.csv.zip` / `.CSV.zip` variants of this URL return a 200 with an
     HTML SPA-fallback page, not a real file.
   - Columns include `TradDt, FinInstrmId, ISIN, TckrSymb, SctySrs, OpnPric, HghPric, LwPric, ClsPric, PrvsClsgPric, TtlTradgVol, TtlTrfVal, TtlNbOfTxsExctd` — no delivery data.
   - The old legacy format `EQ_ISINCODE_DDMMYY.zip` still resolves to *something* for
     old dates (tested working for 2020-09-18) but does **not** have delivery data
     either (`SC_CODE, SC_NAME, ..., NO_OF_SHRS, NET_TURNOV, ISIN_CODE, TRADING_DATE`)
     — don't bother with it.

2. **Gross deliverables file** (the actual delivery data):
   `GET https://www.bseindia.com/BSEDATA/gross/YYYY/SCBSEALLDDMM.zip`
   (year appears in the path, not in the filename; filename has no year).
   - Found by inspecting the "Gross Deliverables" page's rendered download link in a
     browser (`https://www.bseindia.com/markets/equity/EQReports/GrossShortPos?flag=0`)
     — the BSE site is an Angular SPA, so this link is client-rendered and won't show up
     by scraping the page's raw HTML.
   - Real zip file (`PK\x03\x04` magic bytes), contains one pipe-delimited `.TXT` file,
     no header-safe parsing needed beyond splitting on `|`:
     `DATE|SCRIP CODE|DELIVERY QTY|DELIVERY VAL|DAY'S VOLUME|DAY'S TURNOVER|DELV. PER.`
     (fixed-width zero-padded numeric fields, e.g. `0000000000013847`).
   - `DAY'S VOLUME` in this file matched `TtlTradgVol` in the price file for the same
     scrip/date in testing (ABB: 18369 both places) — confirms the join key and that
     both files describe the same trading day consistently.

- **Non-trading-day / missing-file gotcha (important for ingestion code)**: when a
  file doesn't exist (e.g. requesting a weekend date), BSE's server serves its
  Angular SPA's 404 fallback page for the price URL. Critically, **that specific
  error response has malformed HTTP headers** (a stray leading space before the
  header value, e.g. `" X-Frame-Options:  SAMEORIGIN"`), which Node's built-in
  `fetch` (undici)'s strict HTTP/1.1 parser rejects outright as a network-level
  `fetch failed` — not a clean 404. `curl` tolerates this fine. Ingestion code must
  wrap the price-file fetch in try/catch and treat that specific failure as
  "no data for this date," not a hard error. See `scripts/spike/bse.ts`.

---

## NSE symbol master (ISIN mapping) — confirmed 2026-09-21

`sec_bhavdata_full` has no ISIN column, so the cross-exchange mapping table
(CLAUDE.md §4.2) needs NSE's separate master list:

`GET https://archives.nseindia.com/content/equities/EQUITY_L.csv`
(same cookie warm-up as the bhavcopy; `nsearchives.nseindia.com` also works, identical content)

Columns: `SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE`
(again, leading spaces on columns after the first). This is a full-universe snapshot as of
today, not historical — good enough for the ISIN mapping table but re-fetch it periodically
since symbols get added/delisted.

## NSE occasionally serves the wrong file format — confirmed 2026-09-21 (found during backfill)

For **2022-08-08**, `sec_bhavdata_full_08082022.csv` returned HTTP 200 with
`Content-Type: text/csv`, but the actual bytes were a real **XLSX spreadsheet**
(an OOXML zip container: `xl/worksheets/sheet1.xml`, `xl/sharedStrings.xml`, etc.),
not CSV text and not a plain zipped CSV either. This crashed the CSV parser on
first contact ("Invalid Opening Quote"). Only one such date found across the
first ~230 backfilled trading days — looks like a one-off publishing glitch on
NSE's side, not a systematic format change.

Fix: always check the real magic bytes (`PK\x03\x04`) regardless of declared
content-type or URL extension, then check for `xl/workbook.xml` inside the zip
to distinguish "actually XLSX" from "zip-wrapped CSV" (the latter hasn't been
observed for this endpoint but is handled defensively anyway). See
`lib/ingest/xlsx-lite.ts` — a small dependency-free XLSX reader, written
specifically to avoid pulling in the `xlsx` (SheetJS) package, which carries an
unpatched **high-severity** prototype-pollution advisory
(GHSA-4r6h-8v6p-xvw6) with no fix available.

## Storage architecture change — confirmed 2026-09-22 (found during backfill)

Neon's free tier caps a project at **512 MB**. The NSE backfill alone (all EQ
symbols + ETFs, ~2,416,000 rows) consumed **476 MB**, leaving essentially no
room for BSE's larger universe (4,000+ scrips) — confirmed by the BSE
backfill failing on ~560/1304 dates with `could not extend file because
project size limit (512 MB) has been exceeded`.

Rather than upgrade to a paid plan or cut the backfill window, the user chose
to split storage:

- **Local Postgres** (this machine, `LOCAL_DATABASE_URL`): the full raw
  archive, every symbol/series, no filtering. Source of truth for offline
  research. Populated by `npm run backfill -- --db local` (the default).
- **Neon** (`DATABASE_URL`): only symbols meeting the §4.3 liquidity bar
  (20-day median turnover ≥ ₹1cr by default), computed from local data by
  `scripts/compute-liquid-universe.ts` and stored as `symbols.is_scan_universe`.
  This is what the deployed app and the GitHub Actions daily job read/write —
  neither has network access to the local database.

See `db/local.ts`, `db/neon.ts`, `lib/ingest/upsert.ts`'s
`filterToLiquidUniverse`, and `scripts/compute-liquid-universe.ts` for the
implementation. `README.md` has the operational workflow.

## Open items

- NSE's `SERIES` and CSV column values (in both `sec_bhavdata_full` and `EQUITY_L.csv`)
  have leading spaces — trim consistently in the parser (done).
- Need to confirm exact non-trading-day behavior for the NSE archive URL (haven't hit one
  yet — all dates tried so far were valid trading days).
