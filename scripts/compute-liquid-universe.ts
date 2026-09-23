// Computes which symbols meet CLAUDE.md §4.3's default scan-universe
// liquidity bar (20-day median turnover above a threshold, ₹1cr by
// default) from the LOCAL full archive, flags them in both local and Neon,
// and promotes (copies) any newly-liquid symbol's full history from local
// to Neon. This is the only place that flag gets set — daily ingestion and
// Neon-targeted backfills just read it (see filterToLiquidUniverse).
//
// Runs in three passes, deliberately in this order:
//   1. Compute the flag for every symbol, update local + Neon's `symbols`
//      metadata (cheap — never touches daily_bars).
//   2. Prune Neon daily_bars for everything NOT liquid (--prune only).
//   3. Promote (copy full history) for anything newly liquid.
// Pass 2 must run before pass 3: promoting a symbol means inserting a lot
// of data into Neon, and Neon starts out nearly full (see
// DATA_SOURCES.md) — trying to promote before freeing space from pass 2
// just hits the same "project size limit exceeded" error immediately.
// Confirmed the hard way: an earlier single-pass version tried to promote
// the very first symbol before any pruning had happened, and failed
// instantly.
//
// Run this locally, periodically (there's no way to run it from GitHub
// Actions — it needs the local archive). Every pass is resilient to a
// single symbol failing (a transient Neon network hiccup killed an earlier
// version mid-run) — failures are logged and skipped, never fatal.
//
// Usage:
//   npm run compute-universe -- --exchange NSE
//   npm run compute-universe -- --exchange BSE --min-turnover-cr 1.0
//   npm run compute-universe -- --exchange NSE --prune   (also deletes Neon
//     daily_bars for symbols that dropped OUT of the universe, to reclaim space)
import "dotenv/config";
import { and, desc, eq, sql } from "drizzle-orm";
import { localDb } from "../db/local";
import { db as neonDb } from "../db";
import { symbols, dailyBars, scanRuns } from "../db/schema";
import { median } from "../lib/engine/baseline";
import type { Exchange } from "../lib/ingest/types";

const DEFAULT_MIN_TURNOVER_CR = 1.0;
const LOOKBACK_DAYS = 20;
const CHUNK_SIZE = 500;

function parseArgs() {
  const args = process.argv;
  const i = args.indexOf("--exchange");
  const exchange = i === -1 ? undefined : (args[i + 1] as Exchange);
  if (!exchange || (exchange !== "NSE" && exchange !== "BSE")) {
    throw new Error("--exchange NSE|BSE is required");
  }
  const tIdx = args.indexOf("--min-turnover-cr");
  const minTurnoverCr = tIdx === -1 ? DEFAULT_MIN_TURNOVER_CR : Number(args[tIdx + 1]);
  const prune = args.includes("--prune");
  return { exchange, minTurnoverCr, prune };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface LocalSymbol {
  id: number;
  symbol: string;
  series: string;
  isin: string | null;
  name: string | null;
  firstSeen: string;
  lastSeen: string;
}

async function main() {
  const { exchange, minTurnoverCr, prune } = parseArgs();
  console.log(`Computing liquid universe for ${exchange}, threshold ₹${minTurnoverCr}cr median turnover over ${LOOKBACK_DAYS} days`);

  // Recorded in Neon (not local) so the deployed Admin page — which only
  // ever reads Neon — can show when this last ran and warn if it's gone
  // stale. This script is the only thing that can run it (needs the local
  // archive), so without this record Admin would have no way to know.
  const startedAt = new Date();
  const [run] = await neonDb
    .insert(scanRuns)
    .values({ runType: "universe", startedAt, status: "running", paramsSnapshot: { exchange, minTurnoverCr, prune } })
    .returning();

  const localSymbols: LocalSymbol[] = await localDb
    .select({ id: symbols.id, symbol: symbols.symbol, series: symbols.series, isin: symbols.isin, name: symbols.name, firstSeen: symbols.firstSeen, lastSeen: symbols.lastSeen })
    .from(symbols)
    .where(eq(symbols.exchange, exchange));
  console.log(`${localSymbols.length} symbols in local archive`);

  const neonExisting = await neonDb
    .select({ symbol: symbols.symbol, series: symbols.series, isScanUniverse: symbols.isScanUniverse })
    .from(symbols)
    .where(eq(symbols.exchange, exchange));
  const neonFlagMap = new Map(neonExisting.map((s) => [`${s.symbol}|${s.series}`, s.isScanUniverse]));

  // --- Pass 1: compute the flag, sync metadata (no daily_bars writes) ---
  const toPromote: LocalSymbol[] = [];
  const toPrune: LocalSymbol[] = [];
  let unchanged = 0;
  const pass1Failed: string[] = [];

  console.log("\nPass 1: computing liquidity + syncing symbol metadata...");
  for (const [i, sym] of localSymbols.entries()) {
    try {
      const recentBars = await localDb
        .select({ turnover: dailyBars.turnover })
        .from(dailyBars)
        .where(eq(dailyBars.symbolId, sym.id))
        .orderBy(desc(dailyBars.date))
        .limit(LOOKBACK_DAYS);

      const turnovers = recentBars.map((b) => (b.turnover === null ? null : Number(b.turnover))).filter((v): v is number => v !== null);
      const medianTurnover = median(turnovers);
      const isLiquid = medianTurnover !== null && medianTurnover / 1e7 >= minTurnoverCr;

      await localDb.update(symbols).set({ isScanUniverse: isLiquid }).where(eq(symbols.id, sym.id));

      const key = `${sym.symbol}|${sym.series}`;
      const wasLiquidInNeon = neonFlagMap.get(key) ?? false;

      await neonDb
        .insert(symbols)
        .values({
          exchange,
          symbol: sym.symbol,
          series: sym.series,
          isin: sym.isin,
          name: sym.name,
          firstSeen: sym.firstSeen,
          lastSeen: sym.lastSeen,
          isScanUniverse: isLiquid,
        })
        .onConflictDoUpdate({
          target: [symbols.exchange, symbols.symbol, symbols.series],
          set: { isin: sql`excluded.isin`, name: sql`excluded.name`, isScanUniverse: sql`excluded.is_scan_universe` },
        });

      if (isLiquid && !wasLiquidInNeon) {
        toPromote.push(sym);
      } else if (!isLiquid) {
        // Covers both a real demotion AND the one-time migration case:
        // symbols from the original unfiltered backfill that have Neon
        // daily_bars despite never having been explicitly flagged liquid.
        toPrune.push(sym);
      } else {
        unchanged++;
      }

      if ((i + 1) % 500 === 0) console.log(`  [${i + 1}/${localSymbols.length}]`);
    } catch (e) {
      console.error(`  [${i + 1}/${localSymbols.length}] ${sym.symbol}: FAILED — ${(e as Error).message}`);
      pass1Failed.push(sym.symbol);
    }
  }
  console.log(`Pass 1 done. toPromote=${toPromote.length} toPrune=${toPrune.length} unchanged=${unchanged} failed=${pass1Failed.length}`);

  // --- Pass 2: prune (free up space) ---
  let pruned = 0;
  const pass2Failed: string[] = [];
  if (prune && toPrune.length > 0) {
    console.log(`\nPass 2: pruning Neon daily_bars for ${toPrune.length} non-liquid symbols...`);
    for (const [i, sym] of toPrune.entries()) {
      try {
        const [neonSym] = await neonDb
          .select({ id: symbols.id })
          .from(symbols)
          .where(and(eq(symbols.exchange, exchange), eq(symbols.symbol, sym.symbol), eq(symbols.series, sym.series)));
        if (neonSym) {
          const deleted = await neonDb.delete(dailyBars).where(eq(dailyBars.symbolId, neonSym.id)).returning();
          if (deleted.length > 0) {
            pruned++;
            if ((i + 1) % 200 === 0) console.log(`  [${i + 1}/${toPrune.length}]`);
          }
        }
      } catch (e) {
        console.error(`  [${i + 1}/${toPrune.length}] ${sym.symbol}: FAILED — ${(e as Error).message}`);
        pass2Failed.push(sym.symbol);
      }
    }
  }
  console.log(`Pass 2 done. pruned=${pruned} failed=${pass2Failed.length}`);

  // --- Pass 3: promote (copy full history for newly-liquid symbols) ---
  let promoted = 0;
  const pass3Failed: string[] = [];
  console.log(`\nPass 3: promoting ${toPromote.length} newly-liquid symbols...`);
  for (const [i, sym] of toPromote.entries()) {
    try {
      await promoteSymbolHistory(sym.id, exchange, sym.symbol, sym.series);
      promoted++;
      console.log(`  [${i + 1}/${toPromote.length}] ${sym.symbol}: PROMOTED`);
    } catch (e) {
      console.error(`  [${i + 1}/${toPromote.length}] ${sym.symbol}: FAILED — ${(e as Error).message}`);
      pass3Failed.push(sym.symbol);
    }
  }
  console.log(`Pass 3 done. promoted=${promoted} failed=${pass3Failed.length}`);

  const allFailed = [...new Set([...pass1Failed, ...pass2Failed, ...pass3Failed])];
  console.log(`\nDone. promoted=${promoted} pruned=${pruned} unchanged=${unchanged}`);
  if (allFailed.length > 0) {
    console.log(`${allFailed.length} symbol(s) hit a failure somewhere: ${allFailed.join(", ")}`);
    console.log("Re-run the same command — each pass only redoes what's still needed.");
  }

  await neonDb
    .update(scanRuns)
    .set({
      finishedAt: new Date(),
      universeSize: unchanged + toPromote.length, // total liquid post-run, not total local symbols
      symbolsWithSignals: promoted, // reusing this column's meaning for run_type='universe'; see db/schema.ts
      status: "completed",
      paramsSnapshot: { exchange, minTurnoverCr, prune, promoted, pruned, unchanged, failed: allFailed.length },
    })
    .where(eq(scanRuns.id, run.id));
}

async function promoteSymbolHistory(localSymbolId: number, exchange: Exchange, symbol: string, series: string) {
  const bars = await localDb.select().from(dailyBars).where(eq(dailyBars.symbolId, localSymbolId));
  if (bars.length === 0) return;

  const [neonSym] = await neonDb
    .select({ id: symbols.id })
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange), eq(symbols.symbol, symbol), eq(symbols.series, series)));
  if (!neonSym) throw new Error(`Neon symbol row missing for ${exchange}:${symbol}:${series} during promotion`);

  for (const batch of chunk(bars, CHUNK_SIZE)) {
    await neonDb
      .insert(dailyBars)
      .values(
        batch.map((b) => ({
          symbolId: neonSym.id,
          date: b.date,
          prevClose: b.prevClose,
          open: b.open,
          high: b.high,
          low: b.low,
          last: b.last,
          close: b.close,
          vwap: b.vwap,
          volume: b.volume,
          turnover: b.turnover,
          trades: b.trades,
          deliveryQty: b.deliveryQty,
          deliveryPct: b.deliveryPct,
        }))
      )
      .onConflictDoUpdate({
        target: [dailyBars.symbolId, dailyBars.date],
        set: {
          prevClose: sql`excluded.prev_close`,
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          last: sql`excluded.last`,
          close: sql`excluded.close`,
          vwap: sql`excluded.vwap`,
          volume: sql`excluded.volume`,
          turnover: sql`excluded.turnover`,
          trades: sql`excluded.trades`,
          deliveryQty: sql`excluded.delivery_qty`,
          deliveryPct: sql`excluded.delivery_pct`,
        },
      });
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
