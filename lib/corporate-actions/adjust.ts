// Corporate action application — CLAUDE.md §6.2.
//
// Pure function: raw bars go in, adjusted bars come out. Never mutates raw
// data in place — daily_bars stays untouched forever; this is the "derived
// view" CLAUDE.md describes, computed on read.
import type { AdjustableBar, AdjustmentAction } from "./types";

function divide(v: number | null, factor: number): number | null {
  return v === null ? null : v / factor;
}

function multiply(v: number | null, factor: number): number | null {
  return v === null ? null : v * factor;
}

/**
 * Adjust a chronologically-ordered series of raw bars for one symbol against
 * a list of corporate actions (both confirmed and unconfirmed — CLAUDE.md
 * §6.3 says unconfirmed detections should still be applied, just flagged in
 * the UI). Multiple actions compose: a bar before two later splits gets
 * divided by the product of both factors.
 */
export function applyCorporateActions<T extends AdjustableBar>(
  bars: T[],
  actions: AdjustmentAction[]
): T[] {
  if (actions.length === 0) return bars;

  return bars.map((bar) => {
    let cumFactor = 1;
    // prevClose describes the PRIOR session's price. On the ex-date bar
    // itself, today's OHLC is already on the new scale, but prevClose still
    // refers to yesterday — pre-split — so it needs one more factor of
    // adjustment than the rest of the row. Confirmed as a real bug against
    // the BECTORFOOD fixture: without this, the ex-date bar's prevClose was
    // left at the raw pre-split value (e.g. 1310.30) while every other bar's
    // prevClose was correctly adjusted, breaking prevClose-based checks
    // (up-day detection, price-change window) for any window spanning it.
    let cumFactorForPrevClose = 1;
    for (const action of actions) {
      if (bar.date < action.exDate) cumFactor *= action.adjFactor;
      if (bar.date <= action.exDate) cumFactorForPrevClose *= action.adjFactor;
    }
    if (cumFactor === 1 && cumFactorForPrevClose === 1) return bar;

    return {
      ...bar,
      prevClose: divide(bar.prevClose, cumFactorForPrevClose),
      open: divide(bar.open, cumFactor),
      high: divide(bar.high, cumFactor),
      low: divide(bar.low, cumFactor),
      last: divide(bar.last, cumFactor),
      close: divide(bar.close, cumFactor),
      vwap: divide(bar.vwap, cumFactor),
      volume: multiply(bar.volume, cumFactor),
      deliveryQty: multiply(bar.deliveryQty, cumFactor),
      // Turnover, trades, and delivery% are currency/ratio/count-of-trades
      // denominated, not share-count denominated — they do NOT scale with a
      // split. CLAUDE.md §6.2 calls this out as a common, subtle bug.
      turnover: bar.turnover,
      trades: bar.trades,
      deliveryPct: bar.deliveryPct,
    };
  });
}
