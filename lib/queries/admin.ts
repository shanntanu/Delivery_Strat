import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "../../db";
import { ingestionLog, corporateActions, symbols, strategies, scanRuns, dailyBars } from "../../db/schema";

export interface IngestionLogRow {
  exchange: string;
  date: string;
  status: string;
  rowsIngested: number | null;
  error: string | null;
  completedAt: string | null;
}

export interface CorporateActionReviewRow {
  id: number;
  symbolId: number;
  symbol: string;
  exchange: string;
  exDate: string;
  type: string;
  ratioNumerator: number;
  ratioDenominator: number;
  adjFactor: number;
  source: string;
  confirmed: boolean;
  notes: string | null;
  beforeBar: { date: string; prevClose: number | null; close: number | null } | null;
  afterBar: { date: string; prevClose: number | null; close: number | null } | null;
}

export interface ScanRunRow {
  id: number;
  runType: string;
  startedAt: string;
  finishedAt: string | null;
  universeSize: number | null;
  symbolsWithSignals: number | null;
  status: string;
  error: string | null;
}

export interface AdminData {
  recentIngestion: IngestionLogRow[];
  pendingActions: CorporateActionReviewRow[];
  recentRuns: ScanRunRow[];
  universeSize: number;
  liquidityThresholdCr: number; // documented default — see compute-liquid-universe.ts
  symbolsTuned: number;
  symbolsNoReliablePattern: number;
  /** Last time scripts/compute-liquid-universe.ts ran against Neon, from its
   * own scan_runs(run_type='universe') row — see admin/page.tsx's staleness
   * banner. null if it has never been run against this database. */
  universeLastComputedAt: string | null;
}

export async function getAdminData(): Promise<AdminData> {
  const [ingestionRows, actionRows, scanRunRows, universeCountRows, tuningCountRows, universeRunRows] = await Promise.all([
    db.select().from(ingestionLog).orderBy(desc(ingestionLog.date)).limit(30),
    db
      .select({
        id: corporateActions.id,
        symbolId: corporateActions.symbolId,
        symbol: symbols.symbol,
        exchange: symbols.exchange,
        exDate: corporateActions.exDate,
        type: corporateActions.type,
        ratioNumerator: corporateActions.ratioNumerator,
        ratioDenominator: corporateActions.ratioDenominator,
        adjFactor: corporateActions.adjFactor,
        source: corporateActions.source,
        confirmed: corporateActions.confirmed,
        notes: corporateActions.notes,
      })
      .from(corporateActions)
      .innerJoin(symbols, eq(symbols.id, corporateActions.symbolId))
      .where(eq(corporateActions.confirmed, false))
      .orderBy(desc(corporateActions.exDate))
      .limit(15), // kept small deliberately — see the per-row fetch note below
    db.select().from(scanRuns).orderBy(desc(scanRuns.id)).limit(15),
    db.select({ id: symbols.id }).from(symbols).where(eq(symbols.isScanUniverse, true)),
    db.select({ tuning: strategies.tuning }).from(strategies).where(eq(strategies.isDefault, true)),
    db
      .select({ finishedAt: scanRuns.finishedAt })
      .from(scanRuns)
      .where(and(eq(scanRuns.runType, "universe"), eq(scanRuns.status, "completed")))
      .orderBy(desc(scanRuns.id))
      .limit(1),
  ]);

  const symbolsTuned = tuningCountRows.filter((r) => (r.tuning as { status?: string } | null)?.status === "tuned").length;
  const symbolsNoReliablePattern = tuningCountRows.filter(
    (r) => (r.tuning as { status?: string } | null)?.status === "no_reliable_pattern"
  ).length;

  // One targeted 2-row query per action (only the exDate bar and the one
  // immediately before it — never the symbol's full history), run in
  // parallel rather than sequentially. An earlier version fetched every bar
  // for the whole symbol, sequentially, per row: fine for a handful of
  // pending actions, but with a large one-time backlog (353 after a fresh
  // detection run) it turned into 50 giant sequential round-trips and the
  // page timed out outright. Confirmed both fixes matter: payload size and
  // round-trip count each independently drop this from unusable to fast.
  const pendingActions: CorporateActionReviewRow[] = await Promise.all(
    actionRows.map(async (a) => {
      const nearbyBars = await db
        .select({ date: dailyBars.date, prevClose: dailyBars.prevClose, close: dailyBars.close })
        .from(dailyBars)
        .where(and(eq(dailyBars.symbolId, a.symbolId), lte(dailyBars.date, a.exDate)))
        .orderBy(desc(dailyBars.date))
        .limit(2);

      const afterBar = nearbyBars.find((b) => b.date === a.exDate) ?? null;
      const beforeBar = nearbyBars.find((b) => b.date !== a.exDate) ?? null;

      return {
        ...a,
        adjFactor: Number(a.adjFactor),
        beforeBar: beforeBar ? { date: beforeBar.date, prevClose: beforeBar.prevClose === null ? null : Number(beforeBar.prevClose), close: beforeBar.close === null ? null : Number(beforeBar.close) } : null,
        afterBar: afterBar ? { date: afterBar.date, prevClose: afterBar.prevClose === null ? null : Number(afterBar.prevClose), close: afterBar.close === null ? null : Number(afterBar.close) } : null,
      };
    })
  );

  return {
    recentIngestion: ingestionRows.map((r) => ({
      exchange: r.exchange,
      date: r.date,
      status: r.status,
      rowsIngested: r.rowsIngested,
      error: r.error,
      completedAt: r.completedAt?.toString() ?? null,
    })),
    pendingActions,
    recentRuns: scanRunRows.map((r) => ({
      id: r.id,
      runType: r.runType,
      startedAt: r.startedAt.toString(),
      finishedAt: r.finishedAt?.toString() ?? null,
      universeSize: r.universeSize,
      symbolsWithSignals: r.symbolsWithSignals,
      status: r.status,
      error: r.error,
    })),
    universeSize: universeCountRows.length,
    liquidityThresholdCr: 1.0,
    symbolsTuned,
    symbolsNoReliablePattern,
    universeLastComputedAt: universeRunRows[0]?.finishedAt?.toString() ?? null,
  };
}
