import { describe, it, expect } from "vitest";
import { applyCorporateActions } from "./adjust";
import type { AdjustableBar } from "./types";

function bar(overrides: Partial<AdjustableBar> & { date: string }): AdjustableBar {
  return {
    prevClose: null,
    open: null,
    high: null,
    low: null,
    last: null,
    close: null,
    vwap: null,
    volume: null,
    turnover: null,
    trades: null,
    deliveryQty: null,
    deliveryPct: null,
    ...overrides,
  };
}

describe("applyCorporateActions", () => {
  it("returns bars unchanged when there are no actions", () => {
    const bars = [bar({ date: "2026-01-01", close: 100 })];
    expect(applyCorporateActions(bars, [])).toEqual(bars);
  });

  it("divides prices, multiplies quantities, and leaves turnover/trades/delivery% untouched — CLAUDE.md §11", () => {
    const bars = [
      bar({
        date: "2025-12-11",
        prevClose: 1300,
        open: 1305,
        high: 1315,
        low: 1290,
        last: 1310,
        close: 1310.3,
        vwap: 1302,
        volume: 55964,
        turnover: 72907935.7,
        trades: 6833,
        deliveryQty: 33741,
        deliveryPct: 60.29,
      }),
    ];
    const [adjusted] = applyCorporateActions(bars, [{ exDate: "2025-12-12", adjFactor: 5 }]);

    expect(adjusted.prevClose).toBeCloseTo(260, 5);
    expect(adjusted.open).toBeCloseTo(261, 5);
    expect(adjusted.high).toBeCloseTo(263, 5);
    expect(adjusted.low).toBeCloseTo(258, 5);
    expect(adjusted.last).toBeCloseTo(262, 5);
    expect(adjusted.close).toBeCloseTo(262.06, 5);
    expect(adjusted.vwap).toBeCloseTo(260.4, 5);
    expect(adjusted.volume).toBe(55964 * 5);
    expect(adjusted.deliveryQty).toBe(33741 * 5);

    // Must NOT scale — this is the "common, subtle bug" CLAUDE.md §6.2 warns about.
    expect(adjusted.turnover).toBe(72907935.7);
    expect(adjusted.trades).toBe(6833);
    expect(adjusted.deliveryPct).toBe(60.29);
  });

  it("does not adjust close/open/etc. on or after the ex-date", () => {
    const bars = [bar({ date: "2025-12-12", close: 271.2 })];
    const [adjusted] = applyCorporateActions(bars, [{ exDate: "2025-12-12", adjFactor: 5 }]);
    expect(adjusted.close).toBe(271.2);
  });

  it("DOES adjust prevClose on the ex-date bar itself — it describes yesterday, which was pre-split", () => {
    const bars = [bar({ date: "2025-12-12", prevClose: 1310.3, close: 271.2 })];
    const [adjusted] = applyCorporateActions(bars, [{ exDate: "2025-12-12", adjFactor: 5 }]);
    expect(adjusted.prevClose).toBeCloseTo(262.06, 5);
    expect(adjusted.close).toBe(271.2); // unchanged — already on the new scale
  });

  it("does not adjust prevClose the day after the ex-date either", () => {
    const bars = [bar({ date: "2025-12-15", prevClose: 271.2, close: 270.3 })];
    const [adjusted] = applyCorporateActions(bars, [{ exDate: "2025-12-12", adjFactor: 5 }]);
    expect(adjusted.prevClose).toBe(271.2);
  });

  it("composes multiple actions across a symbol's history", () => {
    // A bar before two later splits (2:1, then 3:1) gets divided by both.
    const bars = [bar({ date: "2020-01-01", close: 600 })];
    const adjusted = applyCorporateActions(bars, [
      { exDate: "2021-01-01", adjFactor: 2 },
      { exDate: "2022-01-01", adjFactor: 3 },
    ]);
    expect(adjusted[0].close).toBeCloseTo(100, 5); // 600 / 2 / 3
  });

  it("preserves null fields instead of producing NaN", () => {
    const bars = [bar({ date: "2025-12-11", close: null, volume: null })];
    const [adjusted] = applyCorporateActions(bars, [{ exDate: "2025-12-12", adjFactor: 5 }]);
    expect(adjusted.close).toBeNull();
    expect(adjusted.volume).toBeNull();
  });
});
