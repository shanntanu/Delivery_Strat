// Symbol detail page data — CLAUDE.md §10.2. Reads from Neon; reuses the
// Phase 4 engine live (bars are already loaded for the chart, so recomputing
// stats/variants here is cheap and always consistent with what's stored).
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { symbols, corporateActions, strategies, signals as signalsTable } from "../../db/schema";
import { getAdjustedBarsFrom } from "../corporate-actions/loader";
import { detectSignals } from "../engine/detect";
import { simulateTrade } from "../engine/simulate";
import { computeBasicMetrics, computeRandomBaseline, permutationTest } from "../engine/metrics";
import { DEFAULT_STRATEGY_PARAMS } from "../engine/types";
import type { StrategyParams } from "../engine/types";

export interface SymbolHeader {
  exchange: string;
  symbol: string;
  name: string | null;
  lastClose: number | null;
  lastDeliveryPct: number | null;
  lastDeliveryQty: number | null;
  lastDeliveryBaseline: number | null;
  lastBarDate: string | null;
}

export interface CorporateActionRow {
  exDate: string;
  type: string;
  ratioNumerator: number;
  ratioDenominator: number;
  source: string;
  confirmed: boolean;
  notes: string | null;
}

export interface PersistedSignalRow {
  id: number;
  signalDate: string;
  windowStart: string;
  windowEnd: string;
  avgRatio: number | null;
  minRatio: number | null;
  tradesRatio: number | null;
  priceChangePct: number | null;
  entryPrice: number | null;
  fwd5: number | null;
  fwd10: number | null;
  fwd20: number | null;
  exitReason: string | null;
  realizedReturn: number | null;
}

export interface SummaryStats {
  count: number;
  meanReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  maxDrawdown: number | null;
  randomBaselineMean: number | null;
  randomBaselineWinRate: number | null;
  pValue: number | null;
}

export interface WhatDidntWorkResult {
  label: string;
  description: string;
  count: number;
  meanReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
}

export interface ChartBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  deliveryQty: number | null;
  deliveryBaseline: number | null;
}

export interface SymbolDetailData {
  header: SymbolHeader;
  dataQuality: {
    corporateActions: CorporateActionRow[];
    hasUnconfirmed: boolean;
    firstBarDate: string | null;
    lastBarDate: string | null;
  };
  strategyParams: StrategyParams | null;
  strategyIsTuned: boolean;
  signals: PersistedSignalRow[];
  summary: SummaryStats;
  chartBars: ChartBar[];
  whatDidntWork: WhatDidntWorkResult[];
  notFound: boolean;
}

function maxDrawdown(equityCurve: { equity: number }[]): number | null {
  if (equityCurve.length === 0) return null;
  let peak = equityCurve[0].equity;
  let worst = 0;
  for (const { equity } of equityCurve) {
    peak = Math.max(peak, equity);
    worst = Math.min(worst, (equity - peak) / peak);
  }
  return worst * 100;
}

export async function getSymbolDetail(exchange: string, symbol: string): Promise<SymbolDetailData> {
  const [sym] = await db
    .select()
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange as "NSE" | "BSE"), eq(symbols.symbol, symbol)));

  if (!sym) {
    return {
      header: { exchange, symbol, name: null, lastClose: null, lastDeliveryPct: null, lastDeliveryQty: null, lastDeliveryBaseline: null, lastBarDate: null },
      dataQuality: { corporateActions: [], hasUnconfirmed: false, firstBarDate: null, lastBarDate: null },
      strategyParams: null,
      strategyIsTuned: false,
      signals: [],
      summary: { count: 0, meanReturn: null, medianReturn: null, winRate: null, maxDrawdown: null, randomBaselineMean: null, randomBaselineWinRate: null, pValue: null },
      chartBars: [],
      whatDidntWork: [],
      notFound: true,
    };
  }

  const [{ bars, hasUnconfirmedActions }, actionRows, [strategy]] = await Promise.all([
    getAdjustedBarsFrom(db, sym.id),
    db.select().from(corporateActions).where(eq(corporateActions.symbolId, sym.id)).orderBy(asc(corporateActions.exDate)),
    db.select().from(strategies).where(and(eq(strategies.symbolId, sym.id), eq(strategies.isDefault, true))),
  ]);

  const lastBar = bars[bars.length - 1] ?? null;

  // Delivery baseline for the last bar, computed the same way the engine
  // does (median of the prior 20 days), just for the header stat.
  let lastDeliveryBaseline: number | null = null;
  if (bars.length >= 24) {
    const { computeBaseline } = await import("../engine/baseline");
    lastDeliveryBaseline = computeBaseline(bars.map((b) => b.deliveryQty), bars.length - 1, 1, 20, "median");
  }

  const params: StrategyParams = (strategy?.params as StrategyParams | undefined) ?? DEFAULT_STRATEGY_PARAMS;

  let signalRows: PersistedSignalRow[] = [];
  let summary: SummaryStats = {
    count: 0,
    meanReturn: null,
    medianReturn: null,
    winRate: null,
    maxDrawdown: null,
    randomBaselineMean: null,
    randomBaselineWinRate: null,
    pValue: null,
  };

  if (strategy) {
    const persisted = await db
      .select()
      .from(signalsTable)
      .where(eq(signalsTable.strategyId, strategy.id))
      .orderBy(asc(signalsTable.signalDate));

    signalRows = persisted.map((s) => ({
      id: s.id,
      signalDate: s.signalDate,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      avgRatio: s.avgRatio === null ? null : Number(s.avgRatio),
      minRatio: s.minRatio === null ? null : Number(s.minRatio),
      tradesRatio: s.tradesRatio === null ? null : Number(s.tradesRatio),
      priceChangePct: s.priceChangePct === null ? null : Number(s.priceChangePct),
      entryPrice: s.entryPrice === null ? null : Number(s.entryPrice),
      fwd5: s.fwd5 === null ? null : Number(s.fwd5),
      fwd10: s.fwd10 === null ? null : Number(s.fwd10),
      fwd20: s.fwd20 === null ? null : Number(s.fwd20),
      exitReason: s.exitReason,
      realizedReturn: s.realizedReturn === null ? null : Number(s.realizedReturn),
    }));

    const returns = signalRows.map((s) => s.realizedReturn).filter((r): r is number => r !== null);
    if (returns.length > 0) {
      const trades = signalRows
        .filter((s) => s.realizedReturn !== null)
        .map((s) => ({
          signalDate: s.signalDate,
          entryDate: s.windowEnd,
          entryPrice: s.entryPrice ?? 0,
          exitDate: s.signalDate,
          exitPrice: 0,
          exitReason: (s.exitReason ?? "time_exit") as "stop_loss" | "target" | "trailing_stop" | "time_exit",
          barsHeld: 10,
          grossReturn: s.realizedReturn as number,
          realizedReturn: s.realizedReturn as number,
          mfe: 0,
          mae: 0,
          fwd1: null,
          fwd3: null,
          fwd5: s.fwd5,
          fwd10: s.fwd10,
          fwd20: s.fwd20,
        }));
      const basic = computeBasicMetrics(trades);
      const randomBaseline = computeRandomBaseline(bars, signalRows.length, params.execution, params.costs);
      const p = permutationTest(bars, basic.meanReturn ?? 0, signalRows.length, params.execution, params.costs, 2000);

      summary = {
        count: returns.length,
        meanReturn: basic.meanReturn,
        medianReturn: basic.medianReturn,
        winRate: basic.winRate,
        maxDrawdown: maxDrawdown(basic.equityCurve),
        randomBaselineMean: randomBaseline.meanReturn,
        randomBaselineWinRate: randomBaseline.winRate,
        pValue: p,
      };
    }
  }

  // "What didn't work" — CLAUDE.md §10.2 point 6 / §2.3. Reuses the same
  // pure engine with different parameter presets, not bespoke detectors, so
  // this stays consistent with the main pattern's logic by construction.
  const whatDidntWork: WhatDidntWorkResult[] = [];

  const singleDaySpikeParams: StrategyParams = {
    ...params,
    window_days: 1,
    delivery: { min_ratio_each_day: 5, avg_ratio_min: 5, avg_ratio_max: 999 },
    trades: { ...params.trades, enabled: false },
    price: { cum_change_min_pct: 2, cum_change_max_pct: 999, min_up_days: 1, require_above_sma: [] },
  };
  const spikeSignals = detectSignals(bars, singleDaySpikeParams);
  const spikeTrades = spikeSignals.map((s) => simulateTrade(bars, s, params.execution)).filter((t) => t !== null);
  const spikeMetrics = computeBasicMetrics(spikeTrades);
  whatDidntWork.push({
    label: "Single-day delivery spike",
    description: "Delivery ≥5× normal in one day with price up ≥2% — not sustained, per CLAUDE.md §2.3.",
    count: spikeSignals.length,
    meanReturn: spikeMetrics.meanReturn,
    medianReturn: spikeMetrics.medianReturn,
    winRate: spikeMetrics.winRate,
  });

  const priceDownParams: StrategyParams = {
    ...params,
    price: { ...params.price, cum_change_min_pct: -15, cum_change_max_pct: -3, min_up_days: 0 },
  };
  const downSignals = detectSignals(bars, priceDownParams);
  const downTrades = downSignals.map((s) => simulateTrade(bars, s, params.execution)).filter((t) => t !== null);
  const downMetrics = computeBasicMetrics(downTrades);
  whatDidntWork.push({
    label: "Price-down window",
    description: "Same sustained-delivery pattern, but price fell instead of rose — delivery alone can't tell buying from selling.",
    count: downSignals.length,
    meanReturn: downMetrics.meanReturn,
    medianReturn: downMetrics.medianReturn,
    winRate: downMetrics.winRate,
  });

  return {
    header: {
      exchange: sym.exchange,
      symbol: sym.symbol,
      name: sym.name,
      lastClose: lastBar?.close ?? null,
      lastDeliveryPct: lastBar?.deliveryPct ?? null,
      lastDeliveryQty: lastBar?.deliveryQty ?? null,
      lastDeliveryBaseline: lastDeliveryBaseline,
      lastBarDate: lastBar?.date ?? null,
    },
    dataQuality: {
      corporateActions: actionRows.map((a) => ({
        exDate: a.exDate,
        type: a.type,
        ratioNumerator: a.ratioNumerator,
        ratioDenominator: a.ratioDenominator,
        source: a.source,
        confirmed: a.confirmed,
        notes: a.notes,
      })),
      hasUnconfirmed: hasUnconfirmedActions,
      firstBarDate: bars[0]?.date ?? null,
      lastBarDate: lastBar?.date ?? null,
    },
    strategyParams: params,
    strategyIsTuned: !!strategy?.tuning,
    signals: signalRows,
    summary,
    chartBars: bars.map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      deliveryQty: b.deliveryQty,
      deliveryBaseline: null, // filled client-side via rolling calc if needed later
    })),
    whatDidntWork,
    notFound: false,
  };
}
