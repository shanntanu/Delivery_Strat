// Test-only loader for the BECTORFOOD golden fixture (CLAUDE.md §11). Not
// used by the app or ingestion pipeline — this CSV is a different, simpler
// export format (per-symbol historical download) than the bhavcopy files
// lib/ingest actually parses, with Indian comma-grouped numbers and
// descending date order.
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import type { EngineBar } from "../types";

function parseIndianNumber(s: string): number | null {
  const t = s.trim().replace(/,/g, "");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseMonDDYYYY(s: string): string {
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const [dd, mon, yyyy] = s.trim().split("-");
  return `${yyyy}-${months[mon]}-${dd.padStart(2, "0")}`;
}

export function loadBectorfoodFixtureRaw(): EngineBar[] {
  const path = new URL("../../../fixtures/BECTORFOOD.csv", import.meta.url);
  const text = readFileSync(path, "utf-8");

  const records: Record<string, string>[] = parse(text, {
    columns: (header: string[]) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const bars: EngineBar[] = records.map((r) => ({
    date: parseMonDDYYYY(r["Date"]),
    prevClose: parseIndianNumber(r["Prev Close"]),
    open: parseIndianNumber(r["Open Price"]),
    high: parseIndianNumber(r["High Price"]),
    low: parseIndianNumber(r["Low Price"]),
    last: parseIndianNumber(r["Last Price"]),
    close: parseIndianNumber(r["Close Price"]),
    vwap: parseIndianNumber(r["Average Price"]),
    volume: parseIndianNumber(r["Total Traded Quantity"]),
    turnover: parseIndianNumber(r["Turnover ₹"]),
    trades: parseIndianNumber(r["No. of Trades"]),
    deliveryQty: parseIndianNumber(r["Deliverable Qty"]),
    deliveryPct: parseIndianNumber(r["% Dly Qt to Traded Qty"]),
  }));

  // File is newest-first; the engine needs ascending chronological order.
  bars.reverse();
  return bars;
}
