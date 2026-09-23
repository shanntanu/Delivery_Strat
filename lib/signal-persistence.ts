// Shared "run the engine against one symbol's bars and persist the result"
// step — used by both the scan runner (always DEFAULT_STRATEGY_PARAMS) and
// the tuner runner (whatever params tuneStrategy() picked). Extracted so the
// bigint-rounding and upsert-vs-delete-then-insert details live in exactly
// one place.
import { eq } from "drizzle-orm";
import { signals } from "../db/schema";
import { detectSignals } from "./engine/detect";
import { simulateTrade } from "./engine/simulate";
import type { EngineBar, StrategyParams, SimulatedTrade } from "./engine/types";
import type { DbClient } from "./ingest/db-client";

// baseline_delivery/baseline_trades are `bigint` columns; after
// corporate-action adjustment (fractional factors) the computed baseline can
// land on a non-integer. Postgres rejects a float bound to bigint outright.
function roundOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}

export interface PersistResult {
  count: number;
  trades: SimulatedTrade[];
}

/**
 * Detects signals for `params` over `bars`, simulates each, and replaces
 * whatever signals currently exist for `strategyId` with the fresh set.
 *
 * A delete-then-insert, not an upsert: unlike the scan runner (which always
 * re-evaluates the SAME params, so signal dates are stable run to run), the
 * tuner can change a strategy's params entirely — a 3-day window strategy's
 * signal dates don't line up with a 5-day window's, so stale rows from a
 * previous parameter set must be cleared, not merged.
 */
export async function persistSignals(
  db: DbClient,
  symbolId: number,
  strategyId: number,
  bars: EngineBar[],
  params: StrategyParams
): Promise<PersistResult> {
  const detected = detectSignals(bars, params);
  await db.delete(signals).where(eq(signals.strategyId, strategyId));
  if (detected.length === 0) return { count: 0, trades: [] };

  const trades: SimulatedTrade[] = [];
  for (const s of detected) {
    const trade = simulateTrade(bars, s, params.execution, params.costs);
    if (trade) trades.push(trade);

    await db.insert(signals).values({
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
    });
  }

  return { count: detected.length, trades };
}
