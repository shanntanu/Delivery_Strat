export type Exchange = "NSE" | "BSE";

// One row = one symbol's trading activity on one date, in the raw units the
// exchange published them (NOT corporate-action adjusted — see CLAUDE.md §6).
export interface RawBar {
  exchange: Exchange;
  symbol: string;
  series: string;
  isin: string | null;
  name: string | null;
  date: string; // YYYY-MM-DD
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  last: number | null;
  close: number | null;
  vwap: number | null;
  volume: number | null;
  turnover: number | null; // rupees, NOT lacs — normalize at parse time
  trades: number | null;
  deliveryQty: number | null;
  deliveryPct: number | null;
}

export interface FetchDateResult {
  date: string;
  rows: RawBar[];
  /** true when the exchange had no session that day (holiday/weekend) */
  noData: boolean;
}
