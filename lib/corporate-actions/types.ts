export type CorporateActionType = "split" | "bonus" | "consolidation";

export interface DetectedAction {
  exDate: string;
  type: CorporateActionType;
  ratioNumerator: number;
  ratioDenominator: number;
  /** Multiplier: divide pre-ex-date prices by this, multiply pre-ex-date
   * share-denominated quantities by this, to bring them to post-ex-date terms. */
  adjFactor: number;
  /** The unsnapped observed ratio, kept for the admin review UI. */
  rawRatio: number;
  notes: string;
}

/** Minimal bar shape detection needs — one symbol's history, ascending by date. */
export interface BarForDetection {
  date: string;
  close: number | null;
  prevClose: number | null;
}

/** Minimal bar shape the adjuster reads/writes. Generic so it works against
 * both DB rows and plain fixture objects. */
export interface AdjustableBar {
  date: string;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  last: number | null;
  close: number | null;
  vwap: number | null;
  volume: number | null;
  turnover: number | null;
  trades: number | null;
  deliveryQty: number | null;
  deliveryPct: number | null;
}

export interface AdjustmentAction {
  exDate: string;
  adjFactor: number;
}
