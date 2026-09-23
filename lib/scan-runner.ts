// Shared scan orchestration — used by both scripts/scan.ts (CLI) and the
// Admin page's scan-trigger action, so there's exactly one implementation.
import { and, eq, sql } from "drizzle-orm";
import { symbols, strategies, signals, scanRuns } from "../db/schema";
import { getAdjustedBarsFrom } from "./corporate-actions/loader";
import { detectSignals } from "./engine/detect";
import { simulateTrade } from "./engine/simulate";
import { DEFAULT_STRATEGY_PARAMS } from "./engine/types";
import { withRetry } from "./ingest/retry";
import type { DbClient } from "./ingest/db-client";
import type { Exchange } from "./ingest/types";

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

// baseline_delivery/baseline_trades are `bigint` columns; after
// corporate-action adjustment (fractional factors) the computed baseline can
// land on a non-integer. Postgres rejects a float bound to bigint outright.
function roundOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}

async function scanSymbol(db: DbClient, symbolId: number): Promise<number> {
  const { bars } = await getAdjustedBarsFrom(db, symbolId);
  if (bars.length < 30) return 0;

  const detected = detectSignals(bars, DEFAULT_STRATEGY_PARAMS);
  const strategyId = await ensureDefaultStrategy(db, symbolId);
  if (detected.length === 0) return 0;

  for (const s of detected) {
    const trade = simulateTrade(bars, s, DEFAULT_STRATEGY_PARAMS.execution, DEFAULT_STRATEGY_PARAMS.costs);
    const values = {
      symbolId,
      strategyId,
      signalDate: s.signalDate,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      avgRatio: s.avgRatio.toString(),
      minRatio: s.minRatio.toString(),
      tradesRatio: s.tradesRatio?.toString() ?? null,
      priceChangePct: s.priceChangePct.toString(),
      upDays: s.upDays,
      avgDeliveryPct: s.avgDeliveryPct?.toString() ?? null,
      baselineDelivery: roundOrNull(s.baselineDelivery),
      baselineTrades: roundOrNull(s.baselineTrades),
      entryPrice: trade?.entryPrice.toString() ?? null,
      fwd1: trade?.fwd1?.toString() ?? null,
      fwd3: trade?.fwd3?.toString() ?? null,
      fwd5: trade?.fwd5?.toString() ?? null,
      fwd10: trade?.fwd10?.toString() ?? null,
      fwd20: trade?.fwd20?.toString() ?? null,
      mfe10: trade?.mfe?.toString() ?? null,
      mae10: trade?.mae?.toString() ?? null,
      exitReason: trade?.exitReason ?? null,
      realizedReturn: trade?.realizedReturn?.toString() ?? null,
    };

    await db
      .insert(signals)
      .values(values)
      .onConflictDoUpdate({
        target: [signals.symbolId, signals.strategyId, signals.signalDate],
        set: {
          windowStart: values.windowStart,
          windowEnd: values.windowEnd,
          avgRatio: values.avgRatio,
          minRatio: values.minRatio,
          tradesRatio: values.tradesRatio,
          priceChangePct: values.priceChangePct,
          upDays: values.upDays,
          avgDeliveryPct: values.avgDeliveryPct,
          baselineDelivery: values.baselineDelivery,
          baselineTrades: values.baselineTrades,
          entryPrice: values.entryPrice,
          fwd1: values.fwd1,
          fwd3: values.fwd3,
          fwd5: values.fwd5,
          fwd10: values.fwd10,
          fwd20: values.fwd20,
          mfe10: values.mfe10,
          mae10: values.mae10,
          exitReason: values.exitReason,
          realizedReturn: values.realizedReturn,
        },
      });
  }

  return detected.length;
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

    for (const [i, sym] of symbolRows.entries()) {
      try {
        const count = await withRetry(() => scanSymbol(db, sym.id));
        if (count > 0) {
          symbolsWithSignals++;
          totalSignals += count;
        }
        onProgress?.({ index: i + 1, total: symbolRows.length, symbol: sym.symbol, signalCount: count });
      } catch (e) {
        failed.push(sym.symbol);
      }
    }

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
