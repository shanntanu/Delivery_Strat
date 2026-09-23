import { describe, it, expect } from "vitest";
import { simulateTrade } from "./simulate";
import { DEFAULT_STRATEGY_PARAMS } from "./types";
import type { EngineBar } from "./types";

function bar(date: string, o: OhlcOverrides): EngineBar {
  return {
    date,
    prevClose: o.prevClose ?? null,
    open: o.open ?? null,
    high: o.high ?? null,
    low: o.low ?? null,
    last: o.last ?? null,
    close: o.close ?? null,
    vwap: null,
    volume: null,
    turnover: null,
    trades: null,
    deliveryQty: null,
    deliveryPct: null,
  };
}
interface OhlcOverrides {
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  last?: number;
  close?: number;
}

const EXEC = DEFAULT_STRATEGY_PARAMS.execution; // stop 7%, hold 10, no target, no trailing

describe("simulateTrade", () => {
  it("enters at the open of the day AFTER the signal, never the signal day's close — CLAUDE.md §11", () => {
    const bars = [
      bar("2026-01-01", { close: 100 }), // signal day (index 0)
      bar("2026-01-02", { open: 105, high: 106, low: 104, close: 105.5 }), // entry day
      ...Array.from({ length: 10 }, (_, i) => bar(`2026-01-0${3 + i}`, { open: 105, high: 106, low: 104, close: 105 })),
    ];
    const trade = simulateTrade(bars, { signalIndex: 0, signalDate: "2026-01-01" }, EXEC);
    expect(trade).not.toBeNull();
    expect(trade!.entryPrice).toBe(105); // the OPEN of 01-02, not close of 01-01 (100) or close of 01-02 (105.5)
    expect(trade!.entryDate).toBe("2026-01-02");
  });

  it("returns null when there's no future bar to enter on", () => {
    const bars = [bar("2026-01-01", { close: 100 })];
    const trade = simulateTrade(bars, { signalIndex: 0, signalDate: "2026-01-01" }, EXEC);
    expect(trade).toBeNull();
  });

  it("resolves a same-day stop+target hit to the stop (worse outcome) — CLAUDE.md §8.1", () => {
    const bars = [
      bar("2026-01-01", { close: 100 }),
      bar("2026-01-02", { open: 100, high: 100, low: 100, close: 100 }), // entry at 100, stop = 93
      // Day where both the 7% stop (93) AND a hypothetical target would trigger:
      // low crashes through the stop, high spikes far above any target.
      bar("2026-01-03", { open: 100, high: 150, low: 80, close: 90 }),
      ...Array.from({ length: 9 }, () => bar("2026-01-04", { open: 90, high: 90, low: 90, close: 90 })),
    ];
    const execWithTarget = { ...EXEC, target_pct: 10 }; // target = 110, well within day 3's high of 150
    const trade = simulateTrade(bars, { signalIndex: 0, signalDate: "2026-01-01" }, execWithTarget);
    expect(trade!.exitReason).toBe("stop_loss");
    expect(trade!.exitDate).toBe("2026-01-03");
    expect(trade!.exitPrice).toBeCloseTo(93, 5); // 100 * (1 - 7%)
  });

  it("exits at time_exit (close of the last held day) when neither stop nor target ever trigger", () => {
    const bars = [
      bar("2026-01-01", { close: 100 }),
      bar("2026-01-02", { open: 100, high: 101, low: 99, close: 100.5 }),
      ...Array.from({ length: 9 }, (_, i) => bar(`day${i}`, { open: 100, high: 102, low: 98, close: 101 })),
    ];
    const trade = simulateTrade(bars, { signalIndex: 0, signalDate: "2026-01-01" }, EXEC);
    expect(trade!.exitReason).toBe("time_exit");
    expect(trade!.barsHeld).toBe(10); // hold_days
  });

  it("shortens the hold when the data runs out before hold_days elapses", () => {
    const bars = [
      bar("2026-01-01", { close: 100 }),
      bar("2026-01-02", { open: 100, high: 101, low: 99, close: 100.5 }),
      bar("2026-01-03", { open: 100, high: 101, low: 99, close: 101 }),
    ];
    const trade = simulateTrade(bars, { signalIndex: 0, signalDate: "2026-01-01" }, EXEC);
    expect(trade!.barsHeld).toBe(2);
    expect(trade!.exitReason).toBe("time_exit");
  });

  it("applies costs to reduce realizedReturn relative to grossReturn", () => {
    const bars = [
      bar("2026-01-01", { close: 100 }),
      bar("2026-01-02", { open: 100, high: 101, low: 99, close: 100 }),
      ...Array.from({ length: 9 }, () => bar("d", { open: 100, high: 110, low: 99, close: 110 })),
    ];
    const trade = simulateTrade(bars, { signalIndex: 0, signalDate: "2026-01-01" }, EXEC, {
      brokerage_bps: 3,
      slippage_bps: 15,
      include_stt: true,
    });
    expect(trade!.realizedReturn).toBeLessThan(trade!.grossReturn);
  });
});
