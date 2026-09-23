import { describe, it, expect } from "vitest";
import { computeBasicMetrics, mulberry32, computeRandomBaseline, permutationTest, computeSplitDate } from "./metrics";
import { DEFAULT_STRATEGY_PARAMS } from "./types";
import type { SimulatedTrade, EngineBar } from "./types";

function trade(overrides: Partial<SimulatedTrade>): SimulatedTrade {
  return {
    signalDate: "2026-01-01",
    entryDate: "2026-01-02",
    entryPrice: 100,
    exitDate: "2026-01-12",
    exitPrice: 105,
    exitReason: "time_exit",
    barsHeld: 10,
    grossReturn: 5,
    realizedReturn: 5,
    mfe: 6,
    mae: -2,
    fwd1: null,
    fwd3: null,
    fwd5: null,
    fwd10: 5,
    fwd20: null,
    ...overrides,
  };
}

describe("computeBasicMetrics", () => {
  it("handles an empty trade list without throwing", () => {
    const m = computeBasicMetrics([]);
    expect(m.count).toBe(0);
    expect(m.meanReturn).toBeNull();
    expect(m.equityCurve).toEqual([]);
  });

  it("computes mean, median, win rate, best/worst, profit factor", () => {
    const trades = [
      trade({ realizedReturn: 10, entryDate: "2026-01-01" }),
      trade({ realizedReturn: -5, entryDate: "2026-01-02" }),
      trade({ realizedReturn: 2, entryDate: "2026-01-03" }),
    ];
    const m = computeBasicMetrics(trades);
    expect(m.count).toBe(3);
    expect(m.meanReturn).toBeCloseTo((10 - 5 + 2) / 3, 5);
    expect(m.medianReturn).toBe(2);
    expect(m.winRate).toBeCloseTo((2 / 3) * 100, 5);
    expect(m.bestTrade).toBe(10);
    expect(m.worstTrade).toBe(-5);
    expect(m.profitFactor).toBeCloseTo(12 / 5, 5);
  });

  it("tracks max consecutive losses in trade order", () => {
    const trades = [
      trade({ realizedReturn: -1 }),
      trade({ realizedReturn: -1 }),
      trade({ realizedReturn: 1 }),
      trade({ realizedReturn: -1 }),
    ];
    expect(computeBasicMetrics(trades).maxConsecutiveLosses).toBe(2);
  });

  it("builds a compounding equity curve in chronological (entryDate) order", () => {
    const trades = [
      trade({ realizedReturn: 10, entryDate: "2026-02-01", exitDate: "2026-02-11" }),
      trade({ realizedReturn: -10, entryDate: "2026-01-01", exitDate: "2026-01-11" }),
    ];
    const m = computeBasicMetrics(trades);
    // Chronological: -10% first, then +10% -> 0.9 * 1.1 = 0.99
    expect(m.equityCurve[0].equity).toBeCloseTo(0.9, 5);
    expect(m.equityCurve[1].equity).toBeCloseTo(0.99, 5);
  });

  it("groups returns by year", () => {
    const trades = [
      trade({ signalDate: "2022-01-01", realizedReturn: 10 }),
      trade({ signalDate: "2022-06-01", realizedReturn: 20 }),
      trade({ signalDate: "2023-01-01", realizedReturn: -5 }),
    ];
    const m = computeBasicMetrics(trades);
    expect(m.returnsByYear["2022"].count).toBe(2);
    expect(m.returnsByYear["2022"].meanReturn).toBeCloseTo(15, 5);
    expect(m.returnsByYear["2023"].count).toBe(1);
  });
});

describe("mulberry32", () => {
  it("is deterministic given the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });
});

function flatBars(days: number): EngineBar[] {
  const bars: EngineBar[] = [];
  const d = new Date("2020-01-01");
  for (let i = 0; i < days; i++) {
    bars.push({
      date: d.toISOString().slice(0, 10),
      prevClose: 100,
      open: 100,
      high: 101,
      low: 99,
      last: 100,
      close: 100,
      vwap: 100,
      volume: 1000,
      turnover: 10_000_000,
      trades: 100,
      deliveryQty: 500,
      deliveryPct: 50,
    });
    d.setDate(d.getDate() + 1);
  }
  return bars;
}

describe("computeRandomBaseline / permutationTest", () => {
  it("computeRandomBaseline returns a sample and doesn't throw on flat data", () => {
    const bars = flatBars(200);
    const result = computeRandomBaseline(bars, 10, DEFAULT_STRATEGY_PARAMS.execution, undefined);
    expect(result.sampleSize).toBeGreaterThan(0);
  });

  it("permutationTest returns a p-value in [0,1]", () => {
    const bars = flatBars(200);
    const p = permutationTest(bars, 5, 10, DEFAULT_STRATEGY_PARAMS.execution, undefined, 200);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});

describe("computeSplitDate", () => {
  it("splits at the 70th percentile of sorted dates", () => {
    const dates = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
    expect(computeSplitDate(dates, 0.7)).toBe("2026-01-08");
  });
});
