import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { fetchBse, isHtmlFallback } from "./http";
import type { RawBar, FetchDateResult } from "./types";

function parts(date: string) {
  const [yyyy, mm, dd] = date.split("-");
  return { yyyy, mm, dd };
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

interface DeliveryRow {
  deliveryQty: number | null;
  deliveryVal: number | null;
  volume: number | null;
  turnover: number | null;
  deliveryPct: number | null;
}

async function fetchBseDeliverables(
  yyyy: string,
  mm: string,
  dd: string
): Promise<Map<string, DeliveryRow> | null> {
  const url = `https://www.bseindia.com/BSEDATA/gross/${yyyy}/SCBSEALL${dd}${mm}.zip`;
  const res = await fetchBse(url);
  if (!res || !res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 2).toString("hex") !== "504b") return null; // not a real zip

  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length === 0) return null;

  const text = entries[0].getData().toString("utf-8");
  const map = new Map<string, DeliveryRow>();

  for (const line of text.split("\n")) {
    const cols = line.trim().split("|");
    if (cols.length < 7 || cols[0].toUpperCase() === "DATE") continue; // header or blank
    const scripCode = cols[1].trim();
    map.set(scripCode, {
      deliveryQty: num(cols[2]),
      deliveryVal: num(cols[3]),
      volume: num(cols[4]),
      turnover: num(cols[5]),
      deliveryPct: num(cols[6]),
    });
  }
  return map;
}

export async function fetchBseBhavcopy(date: string): Promise<FetchDateResult> {
  const { yyyy, mm, dd } = parts(date);

  const priceUrl = `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${yyyy}${mm}${dd}_F_0000.CSV`;
  const priceRes = await fetchBse(priceUrl);
  if (!priceRes) {
    return { date, rows: [], noData: true };
  }
  if (!priceRes.ok) {
    throw new Error(`BSE bhavcopy fetch failed for ${date}: HTTP ${priceRes.status}`);
  }
  const priceText = await priceRes.text();
  if (isHtmlFallback(priceText) || priceText.trim() === "") {
    return { date, rows: [], noData: true };
  }

  const deliveryMap = await fetchBseDeliverables(yyyy, mm, dd);
  // Delivery file missing on a day the price file exists is a real anomaly,
  // not "no trading" — surface it rather than silently emitting zero deliveries.
  if (!deliveryMap) {
    throw new Error(
      `BSE price bhavcopy exists for ${date} but gross deliverables file is missing/malformed`
    );
  }

  const records: Record<string, string>[] = parse(priceText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Defensive: NSE's archive was confirmed to silently serve a prior day's
  // file with HTTP 200 for a missing date (see nse.ts). BSE hasn't shown
  // that behavior in testing, but the check is cheap insurance against the
  // same class of bug — never trust a 200 without checking the payload's
  // own date matches what was requested.
  const actualDate = records[0]?.["TradDt"];
  if (actualDate && actualDate !== date) {
    return { date, rows: [], noData: true };
  }

  const rows: RawBar[] = [];
  for (const r of records) {
    if (r["Sgmt"] !== "CM" || r["FinInstrmTp"] !== "STK") continue;

    const scripCode = r["FinInstrmId"];
    const deliv = deliveryMap.get(scripCode);
    // Prefer the human-readable ticker for display; fall back to the numeric
    // scrip code on the rare row where it's blank, so `symbol` is never empty.
    const symbol = r["TckrSymb"] || scripCode;

    rows.push({
      exchange: "BSE",
      symbol,
      series: r["SctySrs"],
      isin: r["ISIN"] || null,
      name: r["FinInstrmNm"] || null,
      date,
      prevClose: num(r["PrvsClsgPric"]),
      open: num(r["OpnPric"]),
      high: num(r["HghPric"]),
      low: num(r["LwPric"]),
      last: num(r["LastPric"]),
      close: num(r["ClsPric"]),
      vwap: null, // not published in this file
      volume: num(r["TtlTradgVol"]),
      turnover: num(r["TtlTrfVal"]),
      trades: num(r["TtlNbOfTxsExctd"]),
      deliveryQty: deliv?.deliveryQty ?? null,
      deliveryPct: deliv?.deliveryPct ?? null,
    });
  }

  return { date, rows, noData: false };
}
