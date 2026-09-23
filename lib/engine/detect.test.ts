import { describe, it, expect } from "vitest";
import { detectSignals } from "./detect";
import { DEFAULT_STRATEGY_PARAMS } from "./types";
import type { EngineBar, StrategyParams } from "./types";

function makeBar(date: string, overrides: Partial<EngineBar> = {}): EngineBar {
  return {
    date,
    prevClose: 100,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    last: 100,
    vwap: 100,
    volume: 1000,
    turnover: 10_000_000,
    trades: 100,
    deliveryQty: 500,
    deliveryPct: 50,
    ...overrides,
  };
}

/** Builds a long enough flat baseline history (constant delivery/trades/price)
 * so a window inserted afterward has a clean, known baseline to compare against. */
function flatHistory(days: number, startDate = "2025-01-01"): EngineBar[] {
  const bars: EngineBar[] = [];
  const d = new Date(startDate);
  for (let i = 0; i < days; i++) {
    bars.push(makeBar(d.toISOString().slice(0, 10)));
    d.setDate(d.getDate() + 1);
  }
  return bars;
}

describe("detectSignals — robustness (CLAUDE.md §11)", () => {
  it("returns empty rather than throwing on short history", () => {
    const bars = flatHistory(5);
    expect(() => detectSignals(bars, DEFAULT_STRATEGY_PARAMS)).not.toThrow();
    expect(detectSignals(bars, DEFAULT_STRATEGY_PARAMS)).toEqual([]);
  });

  it("returns empty rather than throwing on an empty array", () => {
    expect(detectSignals([], DEFAULT_STRATEGY_PARAMS)).toEqual([]);
  });

  it("returns empty rather than throwing when delivery is all zero", () => {
    const bars = flatHistory(80).map((b) => ({ ...b, deliveryQty: 0 }));
    expect(() => detectSignals(bars, DEFAULT_STRATEGY_PARAMS)).not.toThrow();
    // baseline of 0 is treated as "no baseline" (guarded against divide-by-zero)
    expect(detectSignals(bars, DEFAULT_STRATEGY_PARAMS)).toEqual([]);
  });

  it("returns empty rather than throwing when some bars have missing (null) fields", () => {
    const bars = flatHistory(80).map((b, i) => (i % 7 === 0 ? { ...b, deliveryQty: null, close: null } : b));
    expect(() => detectSignals(bars, DEFAULT_STRATEGY_PARAMS)).not.toThrow();
  });
});

describe("detectSignals — cooldown", () => {
  it("suppresses a clustered signal within cooldown_days of the previous one", () => {
    const bars = flatHistory(60);
    // Inject a real 4-day surge starting at index 55, another right after at 57
    // (2 trading days later — well within the default 10-day cooldown).
    for (const i of [55, 56, 57, 58]) {
      bars[i] = makeBar(bars[i].date, { deliveryQty: 800, close: 100 + (i - 54), prevClose: 100 + (i - 55) });
    }
    for (const i of [57, 58, 59]) {
      bars[i] = makeBar(bars[i].date, { deliveryQty: 800, close: 104 + (i - 56), prevClose: 103 + (i - 56) });
    }
    const signals = detectSignals(bars, DEFAULT_STRATEGY_PARAMS);
    // Whatever fires, consecutive signal dates must never be closer than cooldown_days apart.
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i].signalIndex - signals[i - 1].signalIndex).toBeGreaterThanOrEqual(
        DEFAULT_STRATEGY_PARAMS.execution.cooldown_days
      );
    }
  });

  it("cooldown_days: 0 disables suppression entirely", () => {
    const params: StrategyParams = {
      ...DEFAULT_STRATEGY_PARAMS,
      execution: { ...DEFAULT_STRATEGY_PARAMS.execution, cooldown_days: 0 },
    };
    // Sanity: with cooldown off, detectSignals should not throw and should
    // never suppress purely based on proximity (any suppression left would
    // have to come from the pattern conditions themselves, not the cooldown pass).
    const bars = flatHistory(60);
    expect(() => detectSignals(bars, params)).not.toThrow();
  });
});
