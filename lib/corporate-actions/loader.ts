// The "derived view" CLAUDE.md §6.2 describes: fetches raw bars +
// corporate actions from the DB and returns adjusted bars. This is the only
// I/O-touching function in this module — detect.ts and adjust.ts stay pure.
import { asc, eq } from "drizzle-orm";
import { db as neonDb } from "../../db";
import { dailyBars, corporateActions } from "../../db/schema";
import { applyCorporateActions } from "./adjust";
import type { DbClient } from "../ingest/db-client";
import type { AdjustableBar } from "./types";

function toNum(v: string | null): number | null {
  return v === null ? null : Number(v);
}

export interface AdjustedBarsResult {
  bars: AdjustableBar[];
  /** Corporate actions applied, so callers (UI) can show which are unconfirmed. */
  actionsApplied: { exDate: string; adjFactor: number; confirmed: boolean; type: string }[];
  hasUnconfirmedActions: boolean;
}

export async function getAdjustedBarsFrom(db: DbClient, symbolId: number): Promise<AdjustedBarsResult> {
  const [rawBars, actions] = await Promise.all([
    db
      .select()
      .from(dailyBars)
      .where(eq(dailyBars.symbolId, symbolId))
      .orderBy(asc(dailyBars.date)),
    db.select().from(corporateActions).where(eq(corporateActions.symbolId, symbolId)),
  ]);

  const bars: AdjustableBar[] = rawBars.map((b) => ({
    date: b.date,
    prevClose: toNum(b.prevClose),
    open: toNum(b.open),
    high: toNum(b.high),
    low: toNum(b.low),
    last: toNum(b.last),
    close: toNum(b.close),
    vwap: toNum(b.vwap),
    volume: b.volume,
    turnover: toNum(b.turnover),
    trades: b.trades,
    deliveryQty: b.deliveryQty,
    deliveryPct: toNum(b.deliveryPct),
  }));

  const adjusted = applyCorporateActions(
    bars,
    actions.map((a) => ({ exDate: a.exDate, adjFactor: Number(a.adjFactor) }))
  );

  return {
    bars: adjusted,
    actionsApplied: actions.map((a) => ({
      exDate: a.exDate,
      adjFactor: Number(a.adjFactor),
      confirmed: a.confirmed,
      type: a.type,
    })),
    hasUnconfirmedActions: actions.some((a) => !a.confirmed),
  };
}

/** Convenience wrapper for the app (Next.js on Vercel), which only ever
 * reads from Neon. */
export async function getAdjustedBars(symbolId: number): Promise<AdjustedBarsResult> {
  return getAdjustedBarsFrom(neonDb, symbolId);
}
