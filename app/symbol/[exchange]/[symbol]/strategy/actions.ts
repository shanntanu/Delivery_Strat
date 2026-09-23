"use server";

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../../../db";
import { symbols, strategies } from "../../../../../db/schema";
import { getAdjustedBarsFrom } from "../../../../../lib/corporate-actions/loader";
import { detectSignals } from "../../../../../lib/engine/detect";
import { simulateTrade } from "../../../../../lib/engine/simulate";
import { computeBasicMetrics } from "../../../../../lib/engine/metrics";
import type { StrategyParams } from "../../../../../lib/engine/types";

export interface PreviewResult {
  signalCount: number;
  medianReturn: number | null;
  meanReturn: number | null;
  winRate: number | null;
}

/**
 * Live preview — CLAUDE.md §10.3: "as the user changes a parameter, re-run
 * the engine ... via a server action and show the updated signal count and
 * median return immediately, before saving." Runs against the same bars the
 * page already loaded once; nothing is persisted here.
 */
export async function previewStrategy(exchange: string, symbol: string, params: StrategyParams): Promise<PreviewResult> {
  const [sym] = await db
    .select({ id: symbols.id })
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange as "NSE" | "BSE"), eq(symbols.symbol, symbol)));
  if (!sym) return { signalCount: 0, medianReturn: null, meanReturn: null, winRate: null };

  const { bars } = await getAdjustedBarsFrom(db, sym.id);
  const signals = detectSignals(bars, params);
  const trades = signals.map((s) => simulateTrade(bars, s, params.execution, params.costs)).filter((t) => t !== null);
  const metrics = computeBasicMetrics(trades);

  return {
    signalCount: signals.length,
    medianReturn: metrics.medianReturn,
    meanReturn: metrics.meanReturn,
    winRate: metrics.winRate,
  };
}

/**
 * Save creates a NEW row rather than mutating (CLAUDE.md §10.3), so history
 * stays revertible. The previously-active custom strategy (if any) is
 * deactivated — exactly one custom strategy is "active" (in effect for the
 * backtest page) at a time; the default row is never touched.
 */
export async function saveStrategy(exchange: string, symbol: string, params: StrategyParams, name: string): Promise<{ id: number }> {
  const [sym] = await db
    .select({ id: symbols.id })
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange as "NSE" | "BSE"), eq(symbols.symbol, symbol)));
  if (!sym) throw new Error(`Symbol not found: ${exchange}:${symbol}`);

  await db
    .update(strategies)
    .set({ isActive: false })
    .where(and(eq(strategies.symbolId, sym.id), eq(strategies.isDefault, false)));

  const [created] = await db
    .insert(strategies)
    .values({
      symbolId: sym.id,
      name: name || `Custom ${new Date().toISOString().slice(0, 16)}`,
      isDefault: false,
      isActive: true,
      params,
    })
    .returning();

  return { id: created.id };
}

/** Reset-to-default: CLAUDE.md §10.3 — "always one click away." Deactivates
 * any active custom strategy so the default takes over again, without
 * deleting saved history. */
export async function resetToDefault(exchange: string, symbol: string): Promise<void> {
  const [sym] = await db
    .select({ id: symbols.id })
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange as "NSE" | "BSE"), eq(symbols.symbol, symbol)));
  if (!sym) return;

  await db
    .update(strategies)
    .set({ isActive: false })
    .where(and(eq(strategies.symbolId, sym.id), eq(strategies.isDefault, false)));
}

export async function activateStrategy(strategyId: number): Promise<void> {
  const [row] = await db.select({ symbolId: strategies.symbolId, isDefault: strategies.isDefault }).from(strategies).where(eq(strategies.id, strategyId));
  if (!row || row.isDefault) return;
  await db
    .update(strategies)
    .set({ isActive: sql`(id = ${strategyId})` })
    .where(and(eq(strategies.symbolId, row.symbolId), eq(strategies.isDefault, false)));
}
