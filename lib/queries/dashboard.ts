// Dashboard data — CLAUDE.md §10.1. Reads from Neon only (the app never
// touches local Postgres — see DATA_SOURCES.md).
import { sql } from "drizzle-orm";
import { db } from "../../db";

export type SymbolStatus = "active_signal" | "in_trade" | "watching" | "no_pattern";
export type ReliabilityBadge = "green" | "amber" | "grey";

export interface DashboardRow {
  symbolId: number;
  exchange: string;
  symbol: string;
  name: string | null;
  signalCount: number;
  medianReturn: number | null;
  winRate: number | null;
  lastSignalDate: string | null;
  status: SymbolStatus;
  badge: ReliabilityBadge;
  /** Whether the badge reflects the full §10.1 criteria (signal count + p-value
   * + OOS agreement) or just signal count, because the tuner hasn't run for
   * this symbol yet. Surfaced honestly rather than implying more confidence
   * than the data supports. */
  badgeIsPartial: boolean;
}

export interface DashboardHeaderStats {
  lastIngestionDate: string | null;
  universeSize: number;
  symbolsWithActiveSignalsToday: number;
  lastScanStatus: string | null;
  lastScanFinishedAt: string | null;
}

function computeBadge(signalCount: number, pValue: number | null, oosAgrees: boolean | null): { badge: ReliabilityBadge; partial: boolean } {
  const hasFullStats = pValue !== null && oosAgrees !== null;

  if (hasFullStats) {
    if (signalCount >= 12 && pValue! < 0.05 && oosAgrees) return { badge: "green", partial: false };
    if ((signalCount >= 8 && signalCount <= 11) || (pValue! >= 0.05 && pValue! < 0.15)) {
      return { badge: "amber", partial: false };
    }
    return { badge: "grey", partial: false };
  }

  // No tuning data yet (tuner hasn't run for this symbol — Phase 9) — fall
  // back to signal count alone, and say so, rather than pretending this is
  // the full three-factor badge CLAUDE.md §10.1 describes.
  if (signalCount >= 12) return { badge: "green", partial: true };
  if (signalCount >= 8) return { badge: "amber", partial: true };
  return { badge: "grey", partial: true };
}

function computeStatus(
  lastSignalDate: string | null,
  latestBarDate: string | null,
  holdDays: number
): SymbolStatus {
  if (!lastSignalDate || !latestBarDate) return "no_pattern";
  if (lastSignalDate === latestBarDate) return "active_signal";

  const daysSince = Math.round((Date.parse(latestBarDate) - Date.parse(lastSignalDate)) / 86_400_000);
  // Approximation: hold_days is in TRADING days, this diff is calendar days.
  // Padding by ~40% covers weekends without a full trading-calendar lookup.
  if (daysSince <= Math.ceil(holdDays * 1.4)) return "in_trade";
  return "watching";
}

export async function getDashboardRows(exchange: "NSE" | "BSE" = "NSE"): Promise<{
  rows: DashboardRow[];
  header: DashboardHeaderStats;
}> {
  const perSymbol = await db.execute(sql`
    select
      s.id as symbol_id,
      s.exchange,
      s.symbol,
      s.name,
      strat.id as strategy_id,
      strat.tuning,
      count(sig.id)::int as signal_count,
      percentile_cont(0.5) within group (order by sig.realized_return::numeric) as median_return,
      (avg(case when sig.realized_return::numeric > 0 then 1.0 else 0.0 end) * 100) as win_rate,
      max(sig.signal_date) as last_signal_date
    from symbols s
    left join strategies strat on strat.symbol_id = s.id and strat.is_default = true
    left join signals sig on sig.symbol_id = s.id and sig.strategy_id = strat.id and sig.realized_return is not null
    where s.exchange = ${exchange} and s.is_scan_universe = true
    group by s.id, s.exchange, s.symbol, s.name, strat.id, strat.tuning
  `);

  const [{ rows: latestBarRows }, { rows: scanRunRows }] = await Promise.all([
    db.execute(sql`select max(date) as latest_date from daily_bars b join symbols s on s.id = b.symbol_id where s.exchange = ${exchange}`),
    db.execute(sql`select status, finished_at from scan_runs order by id desc limit 1`),
  ]);

  const latestBarDate = (latestBarRows[0] as { latest_date: string | null } | undefined)?.latest_date ?? null;
  const lastRun = scanRunRows[0] as { status: string; finished_at: string | null } | undefined;

  const rows: DashboardRow[] = (perSymbol.rows as Record<string, unknown>[]).map((r) => {
    const signalCount = Number(r.signal_count);
    const tuning = r.tuning as { p_value?: number; oos_agrees?: boolean } | null;
    const pValue = tuning?.p_value ?? null;
    const oosAgrees = tuning?.oos_agrees ?? null;
    const { badge, partial } = computeBadge(signalCount, pValue, oosAgrees);
    const lastSignalDate = (r.last_signal_date as string | null) ?? null;

    return {
      symbolId: Number(r.symbol_id),
      exchange: r.exchange as string,
      symbol: r.symbol as string,
      name: r.name as string | null,
      signalCount,
      medianReturn: r.median_return === null ? null : Number(r.median_return),
      winRate: r.win_rate === null ? null : Number(r.win_rate),
      lastSignalDate,
      status: computeStatus(lastSignalDate, latestBarDate, 10),
      badge,
      badgeIsPartial: partial,
    };
  });

  const symbolsWithActiveSignalsToday = rows.filter((r) => r.status === "active_signal").length;

  return {
    rows,
    header: {
      lastIngestionDate: latestBarDate,
      universeSize: rows.length,
      symbolsWithActiveSignalsToday,
      lastScanStatus: lastRun?.status ?? null,
      lastScanFinishedAt: lastRun?.finished_at ?? null,
    },
  };
}
