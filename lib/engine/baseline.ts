// Baseline computation — CLAUDE.md §2.1, §7 `baseline`.
// Pure. The baseline for any window must be computed from data strictly
// before that window — see CLAUDE.md's "no look-ahead bias anywhere" rule.

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Baseline for the window ending at `windowEndIndex` (inclusive), of length
 * `windowDays`. Looks back `lookbackDays` further, ending the day before the
 * window starts — i.e. for window [t-3, t] and lookback 20, the baseline
 * covers [t-23, t-4]. Returns null if there isn't enough history yet.
 */
export function computeBaseline(
  values: (number | null)[],
  windowEndIndex: number,
  windowDays: number,
  lookbackDays: number,
  method: "median" | "mean"
): number | null {
  const windowStartIndex = windowEndIndex - windowDays + 1;
  const baselineEndIndex = windowStartIndex - 1;
  const baselineStartIndex = baselineEndIndex - lookbackDays + 1;

  if (baselineStartIndex < 0) return null;

  const slice = values.slice(baselineStartIndex, baselineEndIndex + 1);
  if (slice.some((v) => v === null)) return null;

  const nums = slice as number[];
  return method === "median" ? median(nums) : mean(nums);
}
