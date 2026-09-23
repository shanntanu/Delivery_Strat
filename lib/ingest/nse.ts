import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { fetchNse, isHtmlFallback } from "./http";
import { isXlsxZip, parseXlsxAsRecords } from "./xlsx-lite";
import type { RawBar, FetchDateResult } from "./types";

function ddmmyyyy(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}${m}${y}`;
}

function parseMonDDYYYY(s: string): string {
  // "18-Sep-2026" -> "2026-09-18"
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const [dd, mon, yyyy] = s.trim().split("-");
  return `${yyyy}-${months[mon]}-${dd.padStart(2, "0")}`;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

let isinMapCache: Map<string, { isin: string; name: string }> | null = null;

/** SYMBOL -> { isin, name }, from NSE's full equity master list. Not historical:
 * always current, so a symbol that existed under a different ISIN in the past
 * (rare, e.g. after a merger) would be misattributed. Good enough for v1. */
export async function fetchNseIsinMap(): Promise<Map<string, { isin: string; name: string }>> {
  if (isinMapCache) return isinMapCache;

  const res = await fetchNse("https://archives.nseindia.com/content/equities/EQUITY_L.csv");
  if (!res.ok) {
    throw new Error(`NSE EQUITY_L.csv fetch failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  const records: Record<string, string>[] = parse(text, {
    columns: (header: string[]) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    trim: true,
  });

  const map = new Map<string, { isin: string; name: string }>();
  for (const r of records) {
    map.set(r["SYMBOL"], { isin: r["ISIN NUMBER"], name: r["NAME OF COMPANY"] });
  }
  isinMapCache = map;
  return map;
}

export async function fetchNseBhavcopy(date: string): Promise<FetchDateResult> {
  const url = `https://archives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy(date)}.csv`;
  const res = await fetchNse(url);

  if (res.status === 404) {
    return { date, rows: [], noData: true };
  }
  if (!res.ok) {
    throw new Error(`NSE bhavcopy fetch failed for ${date}: HTTP ${res.status}`);
  }

  // NSE has been observed serving this file as an actual XLSX spreadsheet
  // (confirmed for 2022-08-08) or, separately, wrapped in a plain ZIP,
  // despite declaring `Content-Type: text/csv`. Always check the real magic
  // bytes rather than trusting the header or the .csv extension.
  const buf = Buffer.from(await res.arrayBuffer());
  let records: Record<string, string>[];

  if (isXlsxZip(buf)) {
    records = parseXlsxAsRecords(buf).map((r) => {
      const trimmed: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) trimmed[k.trim()] = v.trim();
      return trimmed;
    });
  } else {
    let text: string;
    if (buf.slice(0, 2).toString("hex") === "504b") {
      const zip = new AdmZip(buf);
      const entries = zip.getEntries();
      if (entries.length === 0) {
        return { date, rows: [], noData: true };
      }
      text = entries[0].getData().toString("utf-8");
    } else {
      text = buf.toString("utf-8");
    }

    if (isHtmlFallback(text) || text.trim() === "") {
      return { date, rows: [], noData: true };
    }

    records = parse(text, {
      columns: (header: string[]) => header.map((h) => h.trim()),
      skip_empty_lines: true,
      trim: true,
    });
  }

  // CRITICAL: when the requested date has no file (holiday), NSE's archive
  // does NOT 404 — it silently serves the most recent prior trading day's
  // file with HTTP 200. If we don't check the file's own date column against
  // what we asked for, a holiday's rows get stored under the wrong date and
  // ingestion_log wrongly marks the holiday as "success." Confirmed by
  // hitting this exact case while testing (see DATA_SOURCES.md).
  const actualDate = records[0] ? parseMonDDYYYY(records[0]["DATE1"]) : null;
  if (actualDate !== date) {
    return { date, rows: [], noData: true };
  }

  const isinMap = await fetchNseIsinMap();

  const rows: RawBar[] = [];
  for (const r of records) {
    const series = r["SERIES"];
    if (series !== "EQ") continue; // CLAUDE.md §4.1: default universe is EQ only

    const symbol = r["SYMBOL"];
    const mapped = isinMap.get(symbol);
    const turnoverLacs = num(r["TURNOVER_LACS"]);

    rows.push({
      exchange: "NSE",
      symbol,
      series,
      isin: mapped?.isin ?? null,
      name: mapped?.name ?? null,
      date: parseMonDDYYYY(r["DATE1"]),
      prevClose: num(r["PREV_CLOSE"]),
      open: num(r["OPEN_PRICE"]),
      high: num(r["HIGH_PRICE"]),
      low: num(r["LOW_PRICE"]),
      last: num(r["LAST_PRICE"]),
      close: num(r["CLOSE_PRICE"]),
      vwap: num(r["AVG_PRICE"]),
      volume: num(r["TTL_TRD_QNTY"]),
      turnover: turnoverLacs === null ? null : turnoverLacs * 100_000, // lacs -> rupees
      trades: num(r["NO_OF_TRADES"]),
      deliveryQty: num(r["DELIV_QTY"]),
      deliveryPct: num(r["DELIV_PER"]),
    });
  }

  return { date, rows, noData: false };
}
