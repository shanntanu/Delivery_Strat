// Shared scan orchestration — used by both scripts/scan.ts (CLI) and the
// Admin page's scan-trigger action, so there's exactly one implementation.
import { and, eq, sql } from "drizzle-orm";
import { symbols, strategies, scanRuns } from "../db/schema";
import { getAdjustedBarsFrom } from "./corporate-actions/loader";
import { persistSignals } from "./signal-persistence";
import { DEFAULT_STRATEGY_PARAMS } from "./engine/types";
import { withRetry } from "./ingest/retry";
import { mapWithConcurrency } from "./concurrency";
import type { DbClient } from "./ingest/db-client";
import type { Exchange } from "./ingest/types";

// Symbols are independent (separate rows, separate signal sets) and Neon's
// HTTP driver has no per-connection state, so running several at once is
// safe. This is also the main lever on GitHub Actions wall-clock cost — see
// .github/workflows/daily-ingest.yml.
const SCAN_CONCURRENCY = 6;

async function ensureDefaultStrategy(db: DbClient, symbolId: number): Promise<number> {
  // A separate check-then-insert (SELECT existing, INSERT if none) isn't
  // safe here: Neon's HTTP driver makes each query its own connection with
  // no read-after-write guarantee, and a retried scan hit exactly this race
  // in production (28 symbols ended up with two is_default=true rows). The
  // db-level unique index (strategies_one_default_per_symbol) now makes that
  // impossible; this upsert makes it atomic.
  const [row] = await db
    .insert(strategies)
    .values({ symbolId, name: "Default", isDefault: true, isActive: true, params: DEFAULT_STRATEGY_PARAMS })
    .onConflictDoUpdate({
      target: strategies.symbolId,
      targetWhere: sql`is_default = true`,
      set: { isActive: true },
    })
    .returning();
  return row.id;
}

async function scanSymbol(db: DbClient, symbolId: number): Promise<number> {
  const { bars } = await getAdjustedBarsFrom(db, symbolId);
  if (bars.length < 30) return 0;

  const strategyId = await ensureDefaultStrategy(db, symbolId);
  const { count } = await persistSignals(db, symbolId, strategyId, bars, DEFAULT_STRATEGY_PARAMS);
  return count;
}

export interface ScanProgress {
  index: number;
  total: number;
  symbol: string;
  signalCount: number;
}

export interface ScanSummary {
  runId: number;
  universeSize: number;
  symbolsWithSignals: number;
  totalSignals: number;
  failed: string[];
}

export async function runScan(
  db: DbClient,
  exchange: Exchange,
  onProgress?: (p: ScanProgress) => void
): Promise<ScanSummary> {
  const [run] = await withRetry(() =>
    db
      .insert(scanRuns)
      .values({ startedAt: new Date(), status: "running", paramsSnapshot: DEFAULT_STRATEGY_PARAMS })
      .returning()
  );

  try {
    const symbolRows = await withRetry(() =>
      db
        .select({ id: symbols.id, symbol: symbols.symbol })
        .from(symbols)
        .where(and(eq(symbols.exchange, exchange), eq(symbols.isScanUniverse, true)))
    );

    let symbolsWithSignals = 0;
    let totalSignals = 0;
    const failed: string[] = [];
    let completed = 0;

    await mapWithConcurrency(symbolRows, SCAN_CONCURRENCY, async (sym) => {
      try {
        const count = await withRetry(() => scanSymbol(db, sym.id));
        if (count > 0) {
          symbolsWithSignals++;
          totalSignals += count;
        }
        completed++;
        onProgress?.({ index: completed, total: symbolRows.length, symbol: sym.symbol, signalCount: count });
      } catch (e) {
        completed++;
        failed.push(sym.symbol);
      }
    });

    await withRetry(async () => {
      await db
        .update(scanRuns)
        .set({ finishedAt: new Date(), universeSize: symbolRows.length, symbolsWithSignals, status: "completed" })
        .where(eq(scanRuns.id, run.id));
    });

    return { runId: run.id, universeSize: symbolRows.length, symbolsWithSignals, totalSignals, failed };
  } catch (e) {
    try {
      await withRetry(async () => {
        await db
          .update(scanRuns)
          .set({ finishedAt: new Date(), status: "failed", error: (e as Error).message })
          .where(eq(scanRuns.id, run.id));
      });
    } catch {
      // best-effort, see backfill.ts's identical pattern
    }
    throw e;
  }
}
