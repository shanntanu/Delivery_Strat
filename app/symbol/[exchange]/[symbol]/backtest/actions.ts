"use server";

import { and, eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { symbols, strategies, backtests } from "../../../../../db/schema";
import { getAdjustedBarsFrom } from "../../../../../lib/corporate-actions/loader";
import { detectSignals } from "../../../../../lib/engine/detect";
import { simulateTrade } from "../../../../../lib/engine/simulate";
import { computeBasicMetrics } from "../../../../../lib/engine/metrics";
import type { StrategyParams } from "../../../../../lib/engine/types";
import type { SimulatedTrade } from "../../../../../lib/engine/types";

export interface BacktestResult {
  strategyId: number;
  strategyName: string;
  from: string;
  to: string;
  metrics: {
    count: number;
    meanReturn: number | null;
    medianReturn: number | null;
    winRate: number | null;
    bestTrade: number | null;
    worstTrade: number | null;
    profitFactor: number | null;
    avgBarsHeld: number | null;
    maxConsecutiveLosses: number;
  };
  equityCurve: { date: string; equity: number }[];
  trades: SimulatedTrade[];
  returnsByYear: Record<string, { count: number; meanReturn: number; medianReturn: number }>;
}

/**
 * CLAUDE.md §10.4: costs are ON by default — a backtest that ignores
 * brokerage/STT/slippage on a 10-day hold is not a useful number. This
 * action always applies the strategy's own costs block; there is no
 * "no-cost" toggle in this UI.
 */
export async function runBacktest(
  exchange: string,
  symbol: string,
  strategyId: number,
  fromDate: string,
  toDate: string
): Promise<BacktestResult | null> {
  const [sym] = await db
    .select({ id: symbols.id })
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange as "NSE" | "BSE"), eq(symbols.symbol, symbol)));
  if (!sym) return null;

  const [strategy] = await db.select().from(strategies).where(eq(strategies.id, strategyId));
  if (!strategy) return null;

  const params = strategy.params as StrategyParams;
  const { bars } = await getAdjustedBarsFrom(db, sym.id);

  // Detect over the FULL history (baselines/forward-returns need data outside
  // the range), then keep only signals whose own date falls in [from, to] —
  // this is what "date range" means for a backtest, not truncating the
  // underlying series (which would silently break baselines near the edges).
  const allSignals = detectSignals(bars, params);
  const rangedSignals = allSignals.filter((s) => s.signalDate >= fromDate && s.signalDate <= toDate);

  const trades = rangedSignals
    .map((s) => simulateTrade(bars, s, params.execution, params.costs))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const metrics = computeBasicMetrics(trades);

  await db.insert(backtests).values({
    symbolId: sym.id,
    strategyId: strategy.id,
    params: { ...params, __range: { from: fromDate, to: toDate } },
    metrics: {
      count: metrics.count,
      meanReturn: metrics.meanReturn,
      medianReturn: metrics.medianReturn,
      winRate: metrics.winRate,
      bestTrade: metrics.bestTrade,
      worstTrade: metrics.worstTrade,
      profitFactor: metrics.profitFactor,
    },
    equityCurve: metrics.equityCurve,
    trades,
  });

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    from: fromDate,
    to: toDate,
    metrics: {
      count: metrics.count,
      meanReturn: metrics.meanReturn,
      medianReturn: metrics.medianReturn,
      winRate: metrics.winRate,
      bestTrade: metrics.bestTrade,
      worstTrade: metrics.worstTrade,
      profitFactor: metrics.profitFactor,
      avgBarsHeld: metrics.avgBarsHeld,
      maxConsecutiveLosses: metrics.maxConsecutiveLosses,
    },
    equityCurve: metrics.equityCurve,
    trades,
    returnsByYear: metrics.returnsByYear,
  };
}
