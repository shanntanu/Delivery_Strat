// Scans every symbol's ingested history for candidate corporate actions and
// stores them unconfirmed (CLAUDE.md §6.3 — human review happens later, in
// the admin UI). Safe to re-run: skips any (symbol_id, ex_date) already on
// file, whether from a prior detection run or a manually-entered action.
//
// Targets local Postgres by default (the full archive — this is where
// detection should run, over every symbol). Pass --db neon to run it
// against Neon's smaller liquid-subset instead (e.g. right after promoting
// a newly-liquid symbol, to pick up actions for just that data).
//
// Usage:
//   npm run detect-actions -- --exchange NSE
//   npm run detect-actions -- --exchange BSE
//   npm run detect-actions -- --exchange NSE --db neon
import "dotenv/config";
import { asc, eq } from "drizzle-orm";
import { localDb } from "../db/local";
import { db as neonDb } from "../db";
import { symbols, dailyBars, corporateActions } from "../db/schema";
import { detectCorporateActions } from "../lib/corporate-actions/detect";
import type { DbClient } from "../lib/ingest/db-client";
import type { Exchange } from "../lib/ingest/types";

function parseArgs() {
  const i = process.argv.indexOf("--exchange");
  const exchange = i === -1 ? undefined : (process.argv[i + 1] as Exchange);
  if (!exchange || (exchange !== "NSE" && exchange !== "BSE")) {
    throw new Error("--exchange NSE|BSE is required");
  }
  const dbIdx = process.argv.indexOf("--db");
  const target = (dbIdx === -1 ? "local" : process.argv[dbIdx + 1]) as "local" | "neon";
  return { exchange, target };
}

async function processSymbol(db: DbClient, sym: { id: number; symbol: string }) {
  const bars = await db
    .select({ date: dailyBars.date, close: dailyBars.close, prevClose: dailyBars.prevClose })
    .from(dailyBars)
    .where(eq(dailyBars.symbolId, sym.id))
    .orderBy(asc(dailyBars.date));

  if (bars.length < 2) return { detectedCount: 0, insertedCount: 0 };

  const detected = detectCorporateActions(
    bars.map((b) => ({
      date: b.date,
      close: b.close === null ? null : Number(b.close),
      prevClose: b.prevClose === null ? null : Number(b.prevClose),
    }))
  );

  if (detected.length === 0) return { detectedCount: 0, insertedCount: 0 };

  const existing = await db
    .select({ exDate: corporateActions.exDate })
    .from(corporateActions)
    .where(eq(corporateActions.symbolId, sym.id));
  const existingDates = new Set(existing.map((e) => e.exDate));

  const toInsert = detected.filter((d) => !existingDates.has(d.exDate));
  if (toInsert.length === 0) return { detectedCount: detected.length, insertedCount: 0 };

  await db.insert(corporateActions).values(
    toInsert.map((d) => ({
      symbolId: sym.id,
      exDate: d.exDate,
      type: d.type,
      ratioNumerator: d.ratioNumerator,
      ratioDenominator: d.ratioDenominator,
      adjFactor: d.adjFactor.toString(),
      source: "detected" as const,
      confirmed: false,
      notes: d.notes,
    }))
  );

  console.log(
    `${sym.symbol}: ${toInsert.length} new candidate(s) (${detected
      .map((d) => `${d.exDate} ${d.ratioNumerator}:${d.ratioDenominator}`)
      .join(", ")})`
  );

  return { detectedCount: detected.length, insertedCount: toInsert.length };
}

async function main() {
  const { exchange, target } = parseArgs();
  const db: DbClient = target === "local" ? localDb : neonDb;
  console.log(`Target: ${target}`);

  const symbolRows = await db
    .select({ id: symbols.id, symbol: symbols.symbol })
    .from(symbols)
    .where(eq(symbols.exchange, exchange));

  console.log(`Scanning ${symbolRows.length} ${exchange} symbols for corporate actions`);

  let candidatesFound = 0;
  let candidatesInserted = 0;
  const failedSymbols: string[] = [];

  for (const [i, sym] of symbolRows.entries()) {
    try {
      const { detectedCount, insertedCount } = await processSymbol(db, sym);
      candidatesFound += detectedCount;
      candidatesInserted += insertedCount;
    } catch (e) {
      // A transient network error against one symbol (confirmed happening
      // mid-run in testing — a Neon HTTP hiccup) must not kill the whole
      // scan. Note it and keep going; re-running the script picks up
      // whatever these missed (existing candidates are skipped, so it's
      // cheap to just re-run afterwards for the full symbol list).
      console.error(`[${i + 1}/${symbolRows.length}] ${sym.symbol}: FAILED — ${(e as Error).message}`);
      failedSymbols.push(sym.symbol);
    }
  }

  console.log(`\nDone. ${candidatesFound} candidates detected, ${candidatesInserted} newly inserted.`);
  if (failedSymbols.length > 0) {
    console.log(`${failedSymbols.length} symbol(s) failed and were skipped: ${failedSymbols.join(", ")}`);
    console.log("Re-run the same command to retry them — already-detected candidates are skipped.");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
