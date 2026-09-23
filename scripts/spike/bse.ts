// Throwaway Phase 1 spike: verify BSE delivery data fetch actually works today.
// Not part of the app. Prints parsed rows for one day, then exits.
//
// BSE splits price and delivery across two files that must be joined on scrip code:
//   1. Price bhavcopy (SEBI Common Bhavcopy Format): no delivery data.
//   2. Gross deliverables file: delivery qty/value/volume/turnover, keyed by scrip code.

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

function fmtDDMMYYYY(d: Date) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return { dd, mm, yyyy: String(d.getFullYear()) };
}

function priceUrl(yyyy: string, mm: string, dd: string) {
  return `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${yyyy}${mm}${dd}_F_0000.CSV`;
}

async function main() {
  // Walk back to find the most recent trading day with published data.
  for (let back = 1; back <= 6; back++) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    const { dd, mm, yyyy } = fmtDDMMYYYY(d);

    console.log(`\n=== Trying ${dd}-${mm}-${yyyy} ===`);

    // 1. Price bhavcopy (CBFC format, uppercase .CSV, NOT zipped)
    // Note: on a non-trading day / missing file, BSE serves its Angular SPA's
    // 404 fallback, and that specific error response has malformed HTTP headers
    // (leading whitespace before the header value) that Node's strict undici
    // parser rejects outright as a fetch failure, even though curl tolerates it.
    // Ingestion code must catch this and treat it as "no data for this date."
    let priceText: string;
    try {
      const priceRes = await fetch(priceUrl(yyyy, mm, dd), { headers: HEADERS });
      console.log(`Price bhavcopy: ${priceRes.status}`);
      priceText = await priceRes.text();
      if (!priceRes.ok || priceText.startsWith("<!DOCTYPE") || priceText.startsWith("<!doctype")) {
        console.log("  -> not a trading day or file missing, trying earlier date");
        continue;
      }
    } catch (e) {
      console.log(`  -> fetch failed (${(e as Error).message}), treating as no data, trying earlier date`);
      continue;
    }

    // 2. Gross deliverables file (zip), path includes year folder + DDMM (no year in filename)
    const delivUrl = `https://www.bseindia.com/BSEDATA/gross/${yyyy}/SCBSEALL${dd}${mm}.zip`;
    let delivBuf: Buffer;
    try {
      const delivRes = await fetch(delivUrl, { headers: HEADERS });
      delivBuf = Buffer.from(await delivRes.arrayBuffer());
      console.log(`Gross deliverables: ${delivRes.status}, bytes=${delivBuf.length}, isZip=${delivBuf.slice(0, 2).toString("hex") === "504b"}`);
    } catch (e) {
      console.log(`  -> deliverables fetch failed (${(e as Error).message}), trying earlier date`);
      continue;
    }

    if (delivBuf.slice(0, 2).toString("hex") !== "504b") {
      console.log("  -> not a real zip, trying earlier date");
      continue;
    }

    console.log("\n--- Price bhavcopy sample (first 3 lines) ---");
    console.log(priceText.split("\n").slice(0, 3).join("\n"));

    console.log("\nBoth files found for this date. Delivery zip saved for manual unzip inspection is skipped in this spike");
    console.log("(unzip separately if you want to see rows — format is pipe-delimited:");
    console.log("DATE|SCRIP CODE|DELIVERY QTY|DELIVERY VAL|DAY'S VOLUME|DAY'S TURNOVER|DELV. PER.)");
    return;
  }
  console.log("\nNo working BSE date found in the last 6 calendar days.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
