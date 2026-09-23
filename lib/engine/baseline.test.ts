import { describe, it, expect } from "vitest";
import { median, mean, computeBaseline } from "./baseline";

describe("median/mean", () => {
  it("computes median for odd and even length arrays", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("returns null for empty input", () => {
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
  });
});

describe("computeBaseline — CLAUDE.md §11: never includes a day inside the window it's evaluating", () => {
  it("excludes the window entirely from the baseline", () => {
    // 30 days: index 0-19 = "normal" value 10, index 20-23 = window with value
    // 1000 (would blow up the baseline if leaked in), needs lookback=20, window=4.
    const values = Array.from({ length: 24 }, (_, i) => (i >= 20 ? 1000 : 10));
    const windowEndIndex = 23; // window is [20,21,22,23]
    const baseline = computeBaseline(values, windowEndIndex, 4, 20, "median");
    expect(baseline).toBe(10); // must NOT be pulled toward 1000
  });

  it("baseline covers exactly [windowStart-lookback, windowStart-1]", () => {
    // Distinct value markers so we can tell exactly which slice got used.
    const values = [
      ...Array(5).fill(-1), // decoy before the baseline window (index 0-4)
      ...Array(20).fill(7), // baseline window (index 5-24)
      ...Array(4).fill(99), // signal window (index 25-28)
    ];
    const baseline = computeBaseline(values, 28, 4, 20, "median");
    expect(baseline).toBe(7);
  });

  it("returns null when there isn't enough history yet", () => {
    const values = Array(10).fill(5);
    expect(computeBaseline(values, 9, 4, 20, "median")).toBeNull();
  });

  it("returns null if any baseline-window value is null", () => {
    const values: (number | null)[] = [...Array(19).fill(5), null, ...Array(4).fill(5)];
    expect(computeBaseline(values, 23, 4, 20, "median")).toBeNull();
  });
});
