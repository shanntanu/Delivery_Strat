// Per-symbol parameter tuner — CLAUDE.md §9. Deliberately constrained: a
// fixed small grid, not a continuous optimiser, with guardrails against the
// self-deception a free search over ~1200 days of data invites.
import { detectSignals } from "./detect";
import { simulateTrade } from "./simulate";
import { computeBasicMetrics, computeSplitDate } from "./metrics";
import { median } from "./baseline";
import { DEFAULT_STRATEGY_PARAMS } from "./types";
import type { EngineBar, StrategyParams } from "./types";

// CLAUDE.md §9.1 — exactly this grid, nothing more.
const GRID = {
  window_days: [3, 4, 5],
  min_ratio_each_day: [1.2, 1.3, 1.5],
  avg_ratio_min: [1.5, 2.0],
  cum_change_min_pct: [0, 3, 5],
  hold_days: [5, 10, 20],
};

const MIN_SIGNALS_TO_EMIT = 8;

function buildParams(cell: {
  window_days: number;
  min_ratio_each_day: number;
  avg_ratio_min: number;
  cum_change_min_pct: number;
  hold_days: number;
}): StrategyParams {
  return {
    ...DEFAULT_STRATEGY_PARAMS,
    window_days: cell.window_days,
    delivery: { ...DEFAULT_STRATEGY_PARAMS.delivery, min_ratio_each_day: cell.min_ratio_each_day, avg_ratio_min: cell.avg_ratio_min },
    price: { ...DEFAULT_STRATEGY_PARAMS.price, cum_change_min_pct: cell.cum_change_min_pct },
    execution: { ...DEFAULT_STRATEGY_PARAMS.execution, hold_days: cell.hold_days },
  };
}

function* allCells() {
  for (const window_days of GRID.window_days)
    for (const min_ratio_each_day of GRID.min_ratio_each_day)
      for (const avg_ratio_min of GRID.avg_ratio_min)
        for (const cum_change_min_pct of GRID.cum_change_min_pct)
          for (const hold_days of GRID.hold_days)
            yield { window_days, min_ratio_each_day, avg_ratio_min, cum_change_min_pct, hold_days };
}

interface CellResult {
  params: StrategyParams;
  signalCount: number;
  medianReturn: number | null;
  winRate: number | null;
}

function evaluateCell(bars: EngineBar[], params: StrategyParams): CellResult {
  const signals = detectSignals(bars, params);
  const trades = signals.map((s) => simulateTrade(bars, s, params.execution)).filter((t) => t !== null);
  const metrics = computeBasicMetrics(trades);
  return { params, signalCount: signals.length, medianReturn: metrics.medianReturn, winRate: metrics.winRate };
}

export interface TuneResult {
  status: "tuned" | "no_reliable_pattern";
  bestParams?: StrategyParams;
  combinationsSearched: number;
  trainSignalCount?: number;
  trainMedianReturn?: number | null;
  testSignalCount?: number;
  testMedianReturn?: number | null;
  /** Train and test medians disagree in sign — a real warning, not a detail. */
  oosSignFlip?: boolean;
  splitDate?: string;
}

/**
 * Tunes on the first 70% of history, evaluates the untouched last 30%
 * separately (CLAUDE.md §9.1). Ranks by MEDIAN return, win rate as
 * tiebreaker — ranking by mean would select for one lucky outlier.
 */
export function tuneStrategy(bars: EngineBar[]): TuneResult {
  const splitDate = computeSplitDate(bars.map((b) => b.date), 0.7);

  const trainBars = bars.filter((b) => b.date < splitDate);
  const testBars = bars; // simulate on full history; we only ever look at signals whose date is in-range

  let combinationsSearched = 0;
  let best: CellResult | null = null;

  for (const cell of allCells()) {
    combinationsSearched++;
    const params = buildParams(cell);
    const result = evaluateCell(trainBars, params);

    if (result.signalCount < MIN_SIGNALS_TO_EMIT) continue;
    if (result.medianReturn === null) continue;

    if (
      best === null ||
      result.medianReturn > (best.medianReturn as number) ||
      (result.medianReturn === best.medianReturn && (result.winRate ?? 0) > (best.winRate ?? 0))
    ) {
      best = result;
    }
  }

  if (best === null) {
    return { status: "no_reliable_pattern", combinationsSearched };
  }

  // Out-of-sample: same params, signals whose date falls in the test window,
  // simulated against the FULL bar series (so a trade entered near the
  // train/test boundary still has real future bars to walk forward through).
  const testSignals = detectSignals(testBars, best.params).filter((s) => s.signalDate >= splitDate);
  const testTrades = testSignals.map((s) => simulateTrade(testBars, s, best!.params.execution)).filter((t) => t !== null);
  const testMetrics = computeBasicMetrics(testTrades);

  const trainMedian = best.medianReturn as number;
  const testMedian = testMetrics.medianReturn;
  const oosSignFlip = testMedian !== null && Math.sign(trainMedian) !== Math.sign(testMedian) && testMedian !== 0;

  return {
    status: "tuned",
    bestParams: best.params,
    combinationsSearched,
    trainSignalCount: best.signalCount,
    trainMedianReturn: trainMedian,
    testSignalCount: testSignals.length,
    testMedianReturn: testMedian,
    oosSignFlip,
    splitDate,
  };
}

export { median };
