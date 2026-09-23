// Bounded-concurrency map — used by the scan and tuner runners so a full
// universe pass isn't purely sequential (each symbol is a handful of
// independent DB round-trips; Neon's HTTP driver has no per-connection state
// to protect, so running several symbols at once is safe and cuts wall-clock
// time roughly proportionally to `concurrency`). This matters operationally:
// GitHub Actions bills wall-clock minutes, and a private repo's free-tier
// budget is tight against a daily scan run — see .github/workflows/daily-ingest.yml.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 0 }, worker));
  return results;
}
