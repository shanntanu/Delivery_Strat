// Throwaway Phase 1 spike: verify NSE delivery data fetch actually works today.
// Not part of the app. Prints parsed rows for one day, then exits.

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
};

function fmtDateDDMMYYYY(d: Date) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

async function tryUrl(label: string, url: string, cookie: string, referer: string) {
  console.log(`\n--- Trying ${label}: ${url}`);
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, Cookie: cookie, Referer: referer },
    });
    console.log(`${label} status: ${res.status}`);
    if (!res.ok) {
      const text = await res.text();
      console.log(`${label} body (first 300 chars): ${text.slice(0, 300)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`${label} bytes: ${buf.length}`);
    return buf;
  } catch (e) {
    console.log(`${label} error: ${(e as Error).message}`);
    return null;
  }
}

async function main() {
  console.log("Step 1: warm up session on nseindia.com homepage...");
  const homeRes = await fetch("https://www.nseindia.com/", { headers: HEADERS });
  console.log("Homepage status:", homeRes.status);
  const setCookie = homeRes.headers.get("set-cookie");
  console.log("Set-Cookie present:", !!setCookie);

  // Node's fetch doesn't expose multiple Set-Cookie headers via .get(), try getSetCookie()
  let cookies: string[] = [];
  // @ts-ignore - getSetCookie is available on undici Headers in Node 18.14+
  if (typeof homeRes.headers.getSetCookie === "function") {
    // @ts-ignore
    cookies = homeRes.headers.getSetCookie();
  } else if (setCookie) {
    cookies = [setCookie];
  }
  console.log("Cookie count:", cookies.length);
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  console.log("Cookie header being sent:", cookieHeader.slice(0, 200));

  await new Promise((r) => setTimeout(r, 1800)); // rate-limit courtesy

  // Also hit the market-data landing page many scrapers warm up on
  console.log("\nStep 2: warm up on market-data reports page...");
  const warmRes2 = await fetch(
    "https://www.nseindia.com/all-reports",
    { headers: { ...HEADERS, Cookie: cookieHeader, Referer: "https://www.nseindia.com/" } }
  );
  console.log("all-reports status:", warmRes2.status);
  // @ts-ignore
  const cookies2: string[] = typeof warmRes2.headers.getSetCookie === "function" ? warmRes2.headers.getSetCookie() : [];
  const cookieHeader2 = [...cookies, ...cookies2].map((c) => c.split(";")[0]).join("; ");

  await new Promise((r) => setTimeout(r, 1800));

  const today = new Date();
  // NSE archives lag; try today, then walk back a few days to find a trading day with data
  for (let back = 1; back <= 6; back++) {
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    const ddmmyyyy = fmtDateDDMMYYYY(d);

    // Candidate 1: legacy combined bhavcopy-with-delivery file
    const url1 = `https://archives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;
    const buf1 = await tryUrl(`sec_bhavdata_full ${ddmmyyyy}`, url1, cookieHeader2, "https://www.nseindia.com/all-reports");
    if (buf1) {
      console.log(buf1.toString("utf-8").split("\n").slice(0, 5).join("\n"));
      return;
    }
    await new Promise((r) => setTimeout(r, 1800));

    // Candidate 2: nsearchives subdomain (current CDN for archives as of 2024+)
    const url2 = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;
    const buf2 = await tryUrl(`nsearchives sec_bhavdata_full ${ddmmyyyy}`, url2, cookieHeader2, "https://www.nseindia.com/all-reports");
    if (buf2) {
      console.log(buf2.toString("utf-8").split("\n").slice(0, 5).join("\n"));
      return;
    }
    await new Promise((r) => setTimeout(r, 1800));
  }

  console.log("\nNo working NSE URL found in the last 6 calendar days.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
