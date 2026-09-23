import { and, eq, inArray, sql } from "drizzle-orm";
import { symbols, dailyBars, ingestionLog } from "../../db/schema";
import type { DbClient } from "./db-client";
import type { Exchange, RawBar } from "./types";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const CHUNK_SIZE = 500;

/** Upsert symbols seen in this batch, then return a map keyed by
 * "symbol|series" -> symbol_id for use when inserting daily_bars. */
async function upsertSymbols(
  db: DbClient,
  exchange: Exchange,
  rows: RawBar[]
): Promise<Map<string, number>> {
  // Dedupe within the batch (a symbol appears once per date file, but be defensive).
  const bySymbolSeries = new Map<string, RawBar>();
  for (const r of rows) bySymbolSeries.set(`${r.symbol}|${r.series}`, r);
  const unique = [...bySymbolSeries.values()];

  for (const batch of chunk(unique, CHUNK_SIZE)) {
    await db
      .insert(symbols)
      .values(
        batch.map((r) => ({
          exchange,
          symbol: r.symbol,
          series: r.series,
          isin: r.isin,
          name: r.name,
          firstSeen: r.date,
          lastSeen: r.date,
        }))
      )
      .onConflictDoUpdate({
        target: [symbols.exchange, symbols.symbol, symbols.series],
        set: {
          isin: sql`excluded.isin`,
          name: sql`excluded.name`,
          // lastSeen only moves forward: safe even if dates are ingested out of order.
          lastSeen: sql`greatest(${symbols.lastSeen}, excluded.last_seen)`,
        },
      });
  }

  const rowsMatched = await db
    .select({ id: symbols.id, symbol: symbols.symbol, series: symbols.series })
    .from(symbols)
    .where(
      and(
        eq(symbols.exchange, exchange),
        inArray(
          symbols.symbol,
          unique.map((r) => r.symbol)
        )
      )
    );

  const map = new Map<string, number>();
  for (const row of rowsMatched) map.set(`${row.symbol}|${row.series}`, row.id);
  return map;
}

export interface IngestResult {
  rowsIngested: number;
}

export async function upsertDailyBars(
  db: DbClient,
  exchange: Exchange,
  date: string,
  rows: RawBar[]
): Promise<IngestResult> {
  if (rows.length === 0) {
    await db
      .insert(ingestionLog)
      .values({ exchange, date, status: "no_data", rowsIngested: 0, completedAt: new Date() })
      .onConflictDoUpdate({
        target: [ingestionLog.exchange, ingestionLog.date],
        set: { status: "no_data", rowsIngested: 0, error: null, completedAt: new Date() },
      });
    return { rowsIngested: 0 };
  }

  const symbolIdMap = await upsertSymbols(db, exchange, rows);

  for (const batch of chunk(rows, CHUNK_SIZE)) {
    await db
      .insert(dailyBars)
      .values(
        batch.map((r) => {
          const symbolId = symbolIdMap.get(`${r.symbol}|${r.series}`);
          if (!symbolId) {
            throw new Error(`No symbol_id resolved for ${exchange}:${r.symbol}:${r.series}`);
          }
          return {
            symbolId,
            date: r.date,
            prevClose: r.prevClose?.toString() ?? null,
            open: r.open?.toString() ?? null,
            high: r.high?.toString() ?? null,
            low: r.low?.toString() ?? null,
            last: r.last?.toString() ?? null,
            close: r.close?.toString() ?? null,
            vwap: r.vwap?.toString() ?? null,
            volume: r.volume,
            turnover: r.turnover?.toString() ?? null,
            trades: r.trades,
            deliveryQty: r.deliveryQty,
            deliveryPct: r.deliveryPct?.toString() ?? null,
          };
        })
      )
      .onConflictDoUpdate({
        target: [dailyBars.symbolId, dailyBars.date],
        set: {
          prevClose: sql`excluded.prev_close`,
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          last: sql`excluded.last`,
          close: sql`excluded.close`,
          vwap: sql`excluded.vwap`,
          volume: sql`excluded.volume`,
          turnover: sql`excluded.turnover`,
          trades: sql`excluded.trades`,
          deliveryQty: sql`excluded.delivery_qty`,
          deliveryPct: sql`excluded.delivery_pct`,
        },
      });
  }

  await db
    .insert(ingestionLog)
    .values({
      exchange,
      date,
      status: "success",
      rowsIngested: rows.length,
      completedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [ingestionLog.exchange, ingestionLog.date],
      set: { status: "success", rowsIngested: rows.length, error: null, completedAt: new Date() },
    });

  return { rowsIngested: rows.length };
}

export async function recordIngestionFailure(db: DbClient, exchange: Exchange, date: string, error: string) {
  await db
    .insert(ingestionLog)
    .values({ exchange, date, status: "failed", error, completedAt: new Date() })
    .onConflictDoUpdate({
      target: [ingestionLog.exchange, ingestionLog.date],
      set: { status: "failed", error, completedAt: new Date() },
    });
}

export async function getCompletedDates(db: DbClient, exchange: Exchange): Promise<Set<string>> {
  const rows = await db
    .select({ date: ingestionLog.date })
    .from(ingestionLog)
    .where(and(eq(ingestionLog.exchange, exchange), inArray(ingestionLog.status, ["success", "no_data"])));
  return new Set(rows.map((r) => r.date));
}

/** Filters rows down to symbols already flagged as scan-universe members in
 * the GIVEN db (Neon, typically) — used so the daily incremental job and a
 * targeted Neon backfill never need to touch local data. See
 * scripts/compute-liquid-universe.ts for how that flag gets set. */
export async function filterToLiquidUniverse(
  db: DbClient,
  exchange: Exchange,
  rows: RawBar[]
): Promise<RawBar[]> {
  const liquidRows = await db
    .select({ symbol: symbols.symbol, series: symbols.series })
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange), eq(symbols.isScanUniverse, true)));

  const liquidSet = new Set(liquidRows.map((s) => `${s.symbol}|${s.series}`));
  return rows.filter((r) => liquidSet.has(`${r.symbol}|${r.series}`));
}
