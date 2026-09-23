// Shared HTTP plumbing for NSE and BSE ingestion.
// See DATA_SOURCES.md for how each of these behaviors was discovered.

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
};

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// NSE blocks requests without a valid session cookie (403 from Akamai).
// Cache the cookie in-process so a backfill run only pays the warm-up cost once.
let nseCookieCache: { cookie: string; fetchedAt: number } | null = null;
const NSE_COOKIE_TTL_MS = 5 * 60 * 1000;

async function warmUpNseCookie(): Promise<string> {
  if (nseCookieCache && Date.now() - nseCookieCache.fetchedAt < NSE_COOKIE_TTL_MS) {
    return nseCookieCache.cookie;
  }
  const home = await fetch("https://www.nseindia.com/", { headers: BROWSER_HEADERS });
  if (!home.ok) {
    throw new Error(`NSE homepage warm-up failed: HTTP ${home.status}`);
  }
  const cookies = home.headers.getSetCookie().map((c) => c.split(";")[0]);
  const cookie = cookies.join("; ");
  nseCookieCache = { cookie, fetchedAt: Date.now() };
  return cookie;
}

// Rate-limit NSE requests to ~1 per 1.8s per CLAUDE.md §4.1.
let lastNseRequestAt = 0;
const NSE_MIN_INTERVAL_MS = 1800;

export async function fetchNse(url: string, retries = 3): Promise<Response> {
  const cookie = await warmUpNseCookie();

  const wait = NSE_MIN_INTERVAL_MS - (Date.now() - lastNseRequestAt);
  if (wait > 0) await sleep(wait);
  lastNseRequestAt = Date.now();

  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Cookie: cookie, Referer: "https://www.nseindia.com/all-reports" },
    });
    if (res.status === 403 && attempt < retries) {
      // Cookie may have gone stale; force a fresh warm-up and back off.
      nseCookieCache = null;
      await sleep(2 ** attempt * 1000);
      continue;
    }
    return res;
  }
  throw new Error(`NSE request failed after ${retries} attempts: ${url}`);
}

// BSE didn't show NSE's aggressive bot-blocking in testing, but rate-limit
// anyway as a courtesy — no reason to hammer a free public archive.
let lastBseRequestAt = 0;
const BSE_MIN_INTERVAL_MS = 500;

// BSE's 404/SPA-fallback response has malformed HTTP headers that Node's
// strict undici parser rejects as a network-level failure, not a clean
// non-2xx response. Treat that specific failure as "no data," not an error.
export async function fetchBse(url: string): Promise<Response | null> {
  const wait = BSE_MIN_INTERVAL_MS - (Date.now() - lastBseRequestAt);
  if (wait > 0) await sleep(wait);
  lastBseRequestAt = Date.now();

  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    return res;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("fetch failed")) {
      return null;
    }
    throw e;
  }
}

export function isHtmlFallback(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith("<!doctype");
}
