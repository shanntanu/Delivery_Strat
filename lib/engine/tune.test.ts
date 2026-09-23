import { describe, it, expect } from "vitest";
import { tuneStrategy } from "./tune";
import { loadBectorfoodFixtureRaw } from "./test-utils/load-fixture";
import { applyCorporateActions } from "../corporate-actions/adjust";
import type { EngineBar } from "./types";

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

describe("tuneStrategy", () => {
  it("refuses to emit a strategy when no cell reaches the minimum signal count", () => {
    const result = tuneStrategy(flatBars(300)); // no surge anywhere -> zero signals in every cell
    expect(result.status).toBe("no_reliable_pattern");
    expect(result.combinationsSearched).toBe(3 * 3 * 2 * 3 * 3); // 162, CLAUDE.md §9.1
  });

  it("runs against the real BECTORFOOD fixture without throwing and reports OOS metrics when it finds a pattern", () => {
    const rawBars = loadBectorfoodFixtureRaw();
    const bars = applyCorporateActions(rawBars, [{ exDate: "2025-12-12", adjFactor: 5 }]);
    const result = tuneStrategy(bars);

    expect(result.combinationsSearched).toBe(162);
    if (result.status === "tuned") {
      expect(result.trainSignalCount).toBeGreaterThanOrEqual(8);
      expect(result.bestParams).toBeDefined();
      expect(typeof result.oosSignFlip).toBe("boolean");
    } else {
      expect(result.status).toBe("no_reliable_pattern");
    }
  });
});
