// Simple technical indicators the engine needs. Pure.

/** Simple moving average of `values` over the `n` bars ending at `endIndex`
 * (inclusive). Null if there isn't `n` bars of history yet, or any value in
 * range is null. */
export function sma(values: (number | null)[], n: number, endIndex: number): number | null {
  const startIndex = endIndex - n + 1;
  if (startIndex < 0) return null;
  const slice = values.slice(startIndex, endIndex + 1);
  if (slice.some((v) => v === null)) return null;
  const nums = slice as number[];
  return nums.reduce((a, b) => a + b, 0) / n;
}
