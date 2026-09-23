"use server";

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { corporateActions, symbols } from "../../db/schema";
import { runScan } from "../../lib/scan-runner";
import type { Exchange } from "../../lib/ingest/types";

export async function confirmCorporateAction(id: number): Promise<void> {
  await db.update(corporateActions).set({ confirmed: true }).where(eq(corporateActions.id, id));
}

export async function rejectCorporateAction(id: number): Promise<void> {
  await db.delete(corporateActions).where(eq(corporateActions.id, id));
}

export async function correctCorporateAction(
  id: number,
  ratioNumerator: number,
  ratioDenominator: number,
  type: "split" | "bonus" | "consolidation"
): Promise<void> {
  await db
    .update(corporateActions)
    .set({
      ratioNumerator,
      ratioDenominator,
      adjFactor: (ratioNumerator / ratioDenominator).toString(),
      type,
      confirmed: true, // a human-corrected entry is, by construction, reviewed
      source: "manual",
    })
    .where(eq(corporateActions.id, id));
}

export async function addManualCorporateAction(
  exchange: string,
  symbol: string,
  exDate: string,
  type: "split" | "bonus" | "consolidation",
  ratioNumerator: number,
  ratioDenominator: number,
  notes: string
): Promise<void> {
  const [sym] = await db
    .select({ id: symbols.id })
    .from(symbols)
    .where(eq(symbols.symbol, symbol));
  if (!sym) throw new Error(`Symbol not found: ${exchange}:${symbol}`);

  await db.insert(corporateActions).values({
    symbolId: sym.id,
    exDate,
    type,
    ratioNumerator,
    ratioDenominator,
    adjFactor: (ratioNumerator / ratioDenominator).toString(),
    source: "manual",
    confirmed: true,
    notes,
  });
}

/**
 * Dev-time convenience only. A full scan took ~79 minutes for the NSE
 * universe against Neon in testing — far too long for a single request to
 * await, and would exceed any serverless function's execution limit on
 * Vercel outright. So this deliberately does NOT await runScan(): it starts
 * the scan in the background (riding on the long-lived `next dev` process)
 * and returns immediately; the UI polls the scan_runs table (already
 * rendered below) to show progress instead of blocking on this call.
 *
 * CLAUDE.md §3's architecture is explicit that Vercel does no heavy
 * lifting — the real production trigger for this should be a GitHub
 * Actions `workflow_dispatch` call, not an in-process fire-and-forget like
 * this. Not wired up yet (Phase 7 hasn't set up the GitHub repo/Actions
 * this would dispatch to).
 */
export async function triggerScan(exchange: Exchange): Promise<{ started: boolean }> {
  runScan(db, exchange).catch((e) => {
    console.error(`Background scan (${exchange}) failed:`, e);
  });
  return { started: true };
}
