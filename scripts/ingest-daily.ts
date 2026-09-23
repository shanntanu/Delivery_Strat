// Daily incremental ingestion. Run by GitHub Actions after market close
// (19:30 IST / 14:00 UTC — see CLAUDE.md §12). Ingests one date for both
// exchanges; defaults to today (UTC date == IST date at that run time).
//
// Targets Neon only — GitHub Actions has no route to the local Postgres
// archive (see DATA_SOURCES.md), so this deliberately only ever writes the
// liquid scan-universe subset that's already flagged in Neon's own symbols
// table (kept current by periodically running
// scripts/compute-liquid-universe.ts locally).
//
// Usage:
//   npm run ingest:daily [-- --date 2026-09-18]
import "dotenv/config";
import { fetchNseBhavcopy } from "../lib/ingest/nse";
import { fetchBseBhavcopy } from "../lib/ingest/bse";
import { upsertDailyBars, recordIngestionFailure, filterToLiquidUniverse } from "../lib/ingest/upsert";
import { db } from "../db";
import type { Exchange } from "../lib/ingest/types";

function parseDate(): string {
  const i = process.argv.indexOf("--date");
  return i === -1 ? new Date().toISOString().slice(0, 10) : process.argv[i + 1];
}

async function ingestOne(exchange: Exchange, date: string) {
  try {
    const result = exchange === "NSE" ? await fetchNseBhavcopy(date) : await fetchBseBhavcopy(date);
    const liquidRows = await filterToLiquidUniverse(db, exchange, result.rows);
    const { rowsIngested } = await upsertDailyBars(db, exchange, date, liquidRows);
    if (result.noData) {
      console.log(`${exchange} ${date}: no data (holiday/weekend)`);
    } else {
      console.log(`${exchange} ${date}: ${rowsIngested} rows ingested (of ${result.rows.length} total, liquid subset)`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`${exchange} ${date}: FAILED — ${msg}`);
    await recordIngestionFailure(db, exchange, date, msg);
    throw e; // surface failure to the GH Actions job so it shows red
  }
}

async function main() {
  const date = parseDate();
  console.log(`Daily ingestion for ${date}`);

  const results = await Promise.allSettled([ingestOne("NSE", date), ingestOne("BSE", date)]);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`${failures.length} exchange(s) failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
