// Backfill CLI. Resumable: skips any (exchange, date) already recorded in
// ingestion_log as success/no_data, so re-running after an interruption
// (or a crash on one bad day) picks up where it left off.
//
// Targets local Postgres by default — the full raw archive, every symbol.
// Neon (free tier, storage-constrained — see DATA_SOURCES.md) only ever
// gets the liquid scan-universe subset; pass --db neon to backfill THAT
// target directly (rows are filtered to symbols already flagged
// is_scan_universe=true in Neon's own symbols table — see
// scripts/compute-liquid-universe.ts, which sets that flag).
//
// Usage:
//   npm run backfill -- --exchange NSE --from 2021-09-21 [--to 2026-09-18]
//   npm run backfill -- --exchange BSE --from 2021-09-21
//   npm run backfill -- --exchange NSE --from 2021-09-21 --db neon
import "dotenv/config";
import { fetchNseBhavcopy } from "../lib/ingest/nse";
import { fetchBseBhavcopy } from "../lib/ingest/bse";
import { upsertDailyBars, recordIngestionFailure, getCompletedDates, filterToLiquidUniverse } from "../lib/ingest/upsert";
import { localDb } from "../db/local";
import { db as neonDb } from "../db";
import type { Exchange } from "../lib/ingest/types";
import type { DbClient } from "../lib/ingest/db-client";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const exchange = get("--exchange") as Exchange | undefined;
  const from = get("--from");
  const to = get("--to") ?? new Date().toISOString().slice(0, 10);
  const target = (get("--db") ?? "local") as "local" | "neon";

  if (!exchange || (exchange !== "NSE" && exchange !== "BSE")) {
    throw new Error("--exchange NSE|BSE is required");
  }
  if (!from) {
    throw new Error("--from YYYY-MM-DD is required");
  }
  if (target !== "local" && target !== "neon") {
    throw new Error("--db must be 'local' or 'neon'");
  }
  return { exchange, from, to, target };
}

function* dateRange(from: string, to: string) {
  const cur = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cur <= end) {
    const day = cur.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) {
      yield cur.toISOString().slice(0, 10);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

async function main() {
  const { exchange, from, to, target } = parseArgs();
  const db: DbClient = target === "local" ? localDb : neonDb;
  console.log(`Backfilling ${exchange} from ${from} to ${to} -> ${target}`);

  const completed = await getCompletedDates(db, exchange);
  console.log(`${completed.size} dates already completed, will be skipped`);

  const dates = [...dateRange(from, to)].filter((d) => !completed.has(d));
  console.log(`${dates.length} dates to process`);

  let ok = 0;
  let noData = 0;
  let failed = 0;

  for (const [i, date] of dates.entries()) {
    try {
      const result = exchange === "NSE" ? await fetchNseBhavcopy(date) : await fetchBseBhavcopy(date);
      const rowsToWrite = target === "neon" ? await filterToLiquidUniverse(db, exchange, result.rows) : result.rows;
      const { rowsIngested } = await upsertDailyBars(db, exchange, date, rowsToWrite);
      if (result.noData) {
        noData++;
        console.log(`[${i + 1}/${dates.length}] ${date}: no data (holiday/weekend)`);
      } else {
        ok++;
        console.log(`[${i + 1}/${dates.length}] ${date}: ${rowsIngested} rows${target === "neon" ? ` (of ${result.rows.length} total, liquid subset)` : ""}`);
      }
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      console.error(`[${i + 1}/${dates.length}] ${date}: FAILED — ${msg}`);
      // Recording the failure is best-effort: a transient network error here
      // must not crash the whole backfill (it did — confirmed during the
      // real run, a Neon HTTP hiccup while logging killed a run 300+ dates
      // in). Worst case, that one date is retried on the next resume instead
      // of being marked "failed" — never lost, never silently skipped.
      try {
        await recordIngestionFailure(db, exchange, date, msg);
      } catch (logError) {
        console.error(`  (also failed to record this failure: ${(logError as Error).message})`);
      }
    }
  }

  console.log(`\nDone. ok=${ok} noData=${noData} failed=${failed}`);
  if (failed > 0) {
    console.log("Re-run the same command to retry failed dates — completed dates are skipped.");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
