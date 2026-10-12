// Neon's HTTP driver opens a fresh HTTPS connection per query (no pooling),
// and this session has repeatedly seen intermittent "fetch failed" errors
// under rapid back-to-back requests — confirmed across ingestion, the
// data-migration scripts, and the scan runner. Per-script ad-hoc try/catch
// turns a crash into a skip, but for cheap, fast operations (a single
// insert, not a slow per-symbol fetch) it's cheaper to just retry a couple
// of times first, so a scan run doesn't skip 1 symbol in 5 for a blip that
// clears in under a second.
// Drizzle wraps driver errors: the top-level message is "Failed query: ..." and
// the real "fetch failed" only appears down the `cause` chain, so checking the
// top message alone never matched and these errors were never retried.
function isFetchFailure(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (((cur as Error).message ?? "").includes("fetch failed")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 300): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isFetchFailure(e) || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
  throw lastError;
}
