// Daily incremental ingestion with self-healing catch-up. Run by GitHub
// Actions after market close (19:30 IST / 14:00 UTC — see CLAUDE.md §12).
//
// Without --date, this does NOT just ingest "today": it ingests every
// weekday since the last successful date that isn't already resolved in
// ingestion_log. A missed run (Actions outage, NSE hiccup, a red job nobody
// noticed for a week) therefore heals itself on the next run instead of
// leaving a permanent gap — the earlier "today only" version could never
// recover a missed day.
//
// Retry rules per weekday in the window [last success - 7d, today]:
//   success                  -> skip
//   no_data, older than 3d   -> skip (a real holiday)
//   no_data, within 3d       -> retry (today's file may simply not be published yet)
//   failed / never attempted -> ingest
//
// NSE only by default (BSE is paused, CLAUDE.md §13 — code kept, pass
// --exchange BSE to use it). Targets Neon only — GitHub Actions has no route
// to the local archive (see DATA_SOURCES.md), so this writes just the liquid
// scan-universe subset already flagged in Neon's symbols table (kept current
// by running scripts/compute-liquid-universe.ts locally).
//
// Usage:
//   npm run ingest:daily                          # catch up everything missing
//   npm run ingest:daily -- --date 2026-09-22     # force exactly one date
//   npm run ingest:daily -- --exchange BSE
//   npm run ingest:daily -- --dry-run             # show the plan, fetch/write nothing
import "dotenv/config";
import { desc, and, eq, gte } from "drizzle-orm";
import { fetchNseBhavcopy } from "../lib/ingest/nse";
import { fetchBseBhavcopy } from "../lib/ingest/bse";
import { upsertDailyBars, recordIngestionFailure, filterToLiquidUniverse } from "../lib/ingest/upsert";
import { withRetry } from "../lib/ingest/retry";
import { db } from "../db";
import { ingestionLog } from "../db/schema";
import type { Exchange } from "../lib/ingest/types";

const OVERLAP_DAYS = 7;
const NO_DATA_FINAL_AFTER_DAYS = 3;
const ABORT_AFTER_CONSECUTIVE_FAILURES = 3;

// Neon's HTTP driver makes a fresh HTTPS call per query, so a brief network
// wobble or a cold-starting free-tier compute surfaces as "fetch failed".
// 5 tries with 1s/2s/3s/4s backoff rides out those; only DB calls are wrapped
// (they're idempotent upserts/selects), never the NSE download.
const dbRetry = <T>(fn: () => Promise<T>) => withRetry(fn, 5, 1000);

function parseArgs() {
  const get = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const exchange = (get("--exchange") ?? "NSE") as Exchange;
  if (exchange !== "NSE" && exchange !== "BSE") throw new Error("--exchange must be NSE or BSE");
  return { exchange, date: get("--date") };
}

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

function* weekdays(from: string, to: string): Generator<string> {
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow !== 0 && dow !== 6) yield d;
  }
}

async function planDates(exchange: Exchange, today: string): Promise<string[]> {
  const [lastSuccess] = await dbRetry(() =>
    db
      .select({ date: ingestionLog.date })
      .from(ingestionLog)
      .where(and(eq(ingestionLog.exchange, exchange), eq(ingestionLog.status, "success")))
      .orderBy(desc(ingestionLog.date))
      .limit(1)
  );

  if (!lastSuccess) {
    throw new Error(
      `No successful ${exchange} ingestion on record in this database — run a backfill first, or pass --date to force a single date.`
    );
  }

  const windowStart = addDays(lastSuccess.date, -OVERLAP_DAYS);
  const rows = await dbRetry(() =>
    db
      .select({ date: ingestionLog.date, status: ingestionLog.status })
      .from(ingestionLog)
      .where(and(eq(ingestionLog.exchange, exchange), gte(ingestionLog.date, windowStart)))
  );
  const statusByDate = new Map(rows.map((r) => [r.date, r.status]));

  const plan: string[] = [];
  for (const d of weekdays(windowStart, today)) {
    const status = statusByDate.get(d);
    if (status === "success") continue;
    if (status === "no_data" && daysBetween(d, today) > NO_DATA_FINAL_AFTER_DAYS) continue;
    plan.push(d);
  }
  return plan;
}

async function ingestOne(exchange: Exchange, date: string) {
  try {
    const result = exchange === "NSE" ? await fetchNseBhavcopy(date) : await fetchBseBhavcopy(date);
    const liquidRows = await dbRetry(() => filterToLiquidUniverse(db, exchange, result.rows));
    const { rowsIngested } = await dbRetry(() => upsertDailyBars(db, exchange, date, liquidRows));
    if (result.noData) {
      console.log(`${exchange} ${date}: no data (holiday, or file not published yet)`);
    } else {
      console.log(`${exchange} ${date}: ${rowsIngested} rows ingested (of ${result.rows.length} total, liquid subset)`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`${exchange} ${date}: FAILED — ${msg}`);
    await dbRetry(() => recordIngestionFailure(db, exchange, date, msg));
    throw e;
  }
}

async function main() {
  const { exchange, date } = parseArgs();
  const today = new Date().toISOString().slice(0, 10);

  const dates = date ? [date] : await planDates(exchange, today);
  if (dates.length === 0) {
    console.log(`${exchange}: up to date, nothing to ingest.`);
    return;
  }
  console.log(`${exchange}: ${dates.length} date(s) to ingest: ${dates.join(", ")}`);
  if (process.argv.includes("--dry-run")) {
    console.log("--dry-run: nothing fetched or written.");
    return;
  }

  let failures = 0;
  let consecutive = 0;
  for (const d of dates) {
    try {
      await ingestOne(exchange, d);
      consecutive = 0;
    } catch {
      failures++;
      consecutive++;
      if (consecutive >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
        console.error(`${consecutive} consecutive failures — ${exchange} looks unreachable from here, stopping early rather than hammering it.`);
        break;
      }
    }
  }

  if (failures > 0) {
    console.error(`${failures} date(s) failed; they are recorded in ingestion_log and will be retried on the next run.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
