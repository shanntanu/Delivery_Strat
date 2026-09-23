// Backtest statistics — CLAUDE.md §8.2. Pure, except for randomness in the
// baseline/permutation test, which is seeded so results are reproducible in
// tests (and, if we ever want it, in the UI too).
import { median } from "./baseline";
import { simulateTrade } from "./simulate";
import type { EngineBar, SimulatedTrade, StrategyParams } from "./types";

// mulberry32 — tiny, dependency-free, seedable PRNG. We need reproducibility
// for tests, not cryptographic quality.
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BasicMetrics {
  count: number;
  meanReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
  profitFactor: number | null;
  meanMfe: number | null;
  meanMae: number | null;
  avgBarsHeld: number | null;
  maxConsecutiveLosses: number;
  equityCurve: { date: string; equity: number }[];
  returnsByYear: Record<string, { count: number; meanReturn: number; medianReturn: number }>;
}

function meanOf(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeBasicMetrics(trades: SimulatedTrade[]): BasicMetrics {
  if (trades.length === 0) {
    return {
      count: 0,
      meanReturn: null,
      medianReturn: null,
      winRate: null,
      bestTrade: null,
      worstTrade: null,
      profitFactor: null,
      meanMfe: null,
      meanMae: null,
      avgBarsHeld: null,
      maxConsecutiveLosses: 0,
      equityCurve: [],
      returnsByYear: {},
    };
  }

  const returns = trades.map((t) => t.realizedReturn);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);

  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  let maxConsecutiveLosses = 0;
  let current = 0;
  for (const t of trades) {
    if (t.realizedReturn <= 0) {
      current++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, current);
    } else {
      current = 0;
    }
  }

  // Chronological equity curve, fixed position size, fully compounding.
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  let equity = 1;
  const equityCurve = sorted.map((t) => {
    equity *= 1 + t.realizedReturn / 100;
    return { date: t.exitDate, equity };
  });

  const byYear: Record<string, number[]> = {};
  for (const t of trades) {
    const year = t.signalDate.slice(0, 4);
    (byYear[year] ??= []).push(t.realizedReturn);
  }
  const returnsByYear: BasicMetrics["returnsByYear"] = {};
  for (const [year, rets] of Object.entries(byYear)) {
    returnsByYear[year] = {
      count: rets.length,
      meanReturn: meanOf(rets) as number,
      medianReturn: median(rets) as number,
    };
  }

  return {
    count: trades.length,
    meanReturn: meanOf(returns),
    medianReturn: median(returns),
    winRate: (wins.length / trades.length) * 100,
    bestTrade: Math.max(...returns),
    worstTrade: Math.min(...returns),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : null) : grossProfit / grossLoss,
    meanMfe: meanOf(trades.map((t) => t.mfe)),
    meanMae: meanOf(trades.map((t) => t.mae)),
    avgBarsHeld: meanOf(trades.map((t) => t.barsHeld)),
    maxConsecutiveLosses,
    equityCurve,
    returnsByYear,
  };
}

/** Valid entry indices for a random-baseline draw: needs a real open price. */
function validEntryIndices(bars: EngineBar[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) if (bars[i].open !== null) out.push(i);
  return out;
}

function sampleWithoutReplacement(pool: number[], count: number, rng: () => number): number[] {
  const copy = [...pool];
  const picked: number[] = [];
  for (let i = 0; i < count && copy.length > 0; i++) {
    const idx = Math.floor(rng() * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return picked;
}

function randomEntryReturns(
  bars: EngineBar[],
  count: number,
  execution: StrategyParams["execution"],
  costs: StrategyParams["costs"] | undefined,
  rng: () => number
): number[] {
  const pool = validEntryIndices(bars);
  const entryIndices = sampleWithoutReplacement(pool, count, rng);
  const returns: number[] = [];
  for (const entryIndex of entryIndices) {
    const trade = simulateTrade(bars, { signalIndex: entryIndex - 1, signalDate: bars[entryIndex]?.date ?? "" }, execution, costs);
    if (trade) returns.push(trade.realizedReturn);
  }
  return returns;
}

export interface RandomBaselineResult {
  meanReturn: number | null;
  winRate: number | null;
  sampleSize: number;
}

/** CLAUDE.md §8.2: "Comparison against a same-count random-entry baseline." */
export function computeRandomBaseline(
  bars: EngineBar[],
  signalCount: number,
  execution: StrategyParams["execution"],
  costs: StrategyParams["costs"] | undefined,
  seed = 42
): RandomBaselineResult {
  const rng = mulberry32(seed);
  const returns = randomEntryReturns(bars, signalCount, execution, costs, rng);
  return {
    meanReturn: meanOf(returns),
    winRate: returns.length > 0 ? (returns.filter((r) => r > 0).length / returns.length) * 100 : null,
    sampleSize: returns.length,
  };
}

/**
 * CLAUDE.md §8.2: permutation test, >=5000 iterations of random entry dates
 * drawn from the same symbol's history. One-tailed: what fraction of random
 * same-count entry sets did AT LEAST AS WELL as the real signals' mean
 * return? A low p-value means the real signals' edge is unlikely by chance.
 */
export function permutationTest(
  bars: EngineBar[],
  realMeanReturn: number,
  signalCount: number,
  execution: StrategyParams["execution"],
  costs: StrategyParams["costs"] | undefined,
  iterations = 5000,
  seed = 1337
): number {
  const rng = mulberry32(seed);
  let atLeastAsGood = 0;
  let validIterations = 0;

  for (let i = 0; i < iterations; i++) {
    const returns = randomEntryReturns(bars, signalCount, execution, costs, rng);
    if (returns.length === 0) continue;
    validIterations++;
    const m = meanOf(returns) as number;
    if (m >= realMeanReturn) atLeastAsGood++;
  }

  return validIterations === 0 ? 1 : atLeastAsGood / validIterations;
}

/**
 * CLAUDE.md §9.1: "Tune on the first 70% of history; record untouched
 * last-30% performance alongside." Splits by DATE (not trade/signal count)
 * so the split point is a fixed point in calendar time, independent of how
 * many signals happen to fall on either side.
 */
export function computeSplitDate(allDates: string[], trainFraction = 0.7): string {
  const sortedDates = [...allDates].sort();
  const splitIdx = Math.floor(sortedDates.length * trainFraction);
  return sortedDates[Math.min(splitIdx, sortedDates.length - 1)];
}

export function splitByDate<T extends { signalDate: string }>(
  items: T[],
  allDates: string[],
  trainFraction = 0.7
): { train: T[]; test: T[]; splitDate: string } {
  const splitDate = computeSplitDate(allDates, trainFraction);
  return {
    train: items.filter((i) => i.signalDate < splitDate),
    test: items.filter((i) => i.signalDate >= splitDate),
    splitDate,
  };
}
