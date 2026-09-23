import { describe, it, expect } from "vitest";
import { detectCorporateActions } from "./detect";
import type { BarForDetection } from "./types";

function bar(date: string, prevClose: number | null, close: number | null): BarForDetection {
  return { date, prevClose, close };
}

describe("detectCorporateActions", () => {
  it("does not flag ordinary trading days", () => {
    const bars = [
      bar("2026-01-01", null, 100),
      bar("2026-01-02", 100, 101),
      bar("2026-01-03", 101, 99),
      bar("2026-01-04", 99, 100.5),
    ];
    expect(detectCorporateActions(bars)).toEqual([]);
  });

  it("does not flag a move just under the 2% threshold", () => {
    const bars = [bar("2026-01-01", null, 100), bar("2026-01-02", 101.5, 100)];
    expect(detectCorporateActions(bars)).toEqual([]);
  });

  it("rejects a move that clears the 2% prevClose threshold but isn't close to any real split ratio", () => {
    // Confirmed against the real local archive: a flat 2% threshold with no
    // fit-quality check produced 190,000+ false-positive candidates across
    // the universe (one volatile smallcap alone generated 437). Every real
    // candidate ratio implies at least a 33% move, so an isolated small
    // deviation like this — however marginally past the raw threshold —
    // must still be rejected.
    const bars = [bar("2026-01-01", null, 100), bar("2026-01-02", 102.5, 100)];
    expect(detectCorporateActions(bars)).toEqual([]);
  });

  it("flags a prevClose deviation that both exceeds 2% and fits a real ratio", () => {
    const bars = [bar("2026-01-01", null, 200), bar("2026-01-02", 101, 100)];
    const result = detectCorporateActions(bars);
    expect(result).toHaveLength(1);
    expect(result[0].adjFactor).toBe(2);
  });

  it("flags a 5:1 split and snaps the noisy raw ratio to 5", () => {
    // Real overnight move is never an exact ratio — BECTORFOOD's actual
    // split day moved from 1310.30 to a 271.20 close on the new scale
    // (implying an adjusted prevClose near 262), a raw factor of ~5.0.
    const bars = [
      bar("2025-12-11", null, 1310.3),
      bar("2025-12-12", 262.06, 271.2), // prevClose already on the new scale
    ];
    const result = detectCorporateActions(bars);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("split");
    expect(result[0].ratioNumerator).toBe(5);
    expect(result[0].ratioDenominator).toBe(1);
    expect(result[0].adjFactor).toBe(5);
    expect(result[0].exDate).toBe("2025-12-12");
  });

  it("flags a 1:1 bonus (defaults to split classification — indistinguishable from price alone)", () => {
    const bars = [bar("2026-02-01", null, 200), bar("2026-02-02", 100, 101)];
    const result = detectCorporateActions(bars);
    expect(result[0].type).toBe("split");
    expect(result[0].adjFactor).toBe(2);
  });

  it("flags a 10:1 consolidation (reverse split)", () => {
    const bars = [bar("2026-03-01", null, 10), bar("2026-03-02", 98, 100)];
    const result = detectCorporateActions(bars);
    expect(result[0].type).toBe("consolidation");
    expect(result[0].ratioNumerator).toBe(1);
    expect(result[0].ratioDenominator).toBe(10);
  });

  it("skips rows with missing prices instead of throwing", () => {
    const bars = [bar("2026-01-01", null, null), bar("2026-01-02", null, 100), bar("2026-01-03", 100, 101)];
    expect(() => detectCorporateActions(bars)).not.toThrow();
    expect(detectCorporateActions(bars)).toEqual([]);
  });

  it("returns empty for a single bar or empty history", () => {
    expect(detectCorporateActions([])).toEqual([]);
    expect(detectCorporateActions([bar("2026-01-01", null, 100)])).toEqual([]);
  });

  it("catches a real action the exchange didn't reflect in prevClose (RELIANCE's actual 2024-10-27 bonus)", () => {
    // Confirmed in production data: prev_close on the ex-date exactly
    // equals the prior day's raw close (2655.70 both) — NSE published no
    // adjusted reference for this one. Only the close-to-close jump
    // (2655.70 -> 1334.35, factor ~1.99) carries the signal.
    const bars = [bar("2024-10-24", 2679.6, 2655.7), bar("2024-10-27", 2655.7, 1334.35)];
    const result = detectCorporateActions(bars);
    expect(result).toHaveLength(1);
    expect(result[0].adjFactor).toBe(2);
    expect(result[0].notes).toContain("close jump");
  });

  it("does not double-flag when both prevClose and close move together (prefers the prevClose signal)", () => {
    const bars = [bar("2025-12-11", null, 1310.3), bar("2025-12-12", 262.06, 271.2)];
    const result = detectCorporateActions(bars);
    expect(result).toHaveLength(1);
    expect(result[0].notes).toContain("prev_close jump");
  });
});
