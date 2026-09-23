// One-off migration helper: Neon already has a complete NSE backfill from
// before the local/Neon split existed (see DATA_SOURCES.md). Rather than
// re-fetching all of NSE from the exchange archive again (slow, rate
// limited), copy that data straight into local Postgres. BSE still needs a
// fresh backfill against local — most of its Neon data failed to write due
// to the storage cap, so it's not a reliable source to copy from.
//
// Usage:
//   npm run copy-neon-to-local -- --exchange NSE
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { localDb } from "../db/local";
import { db as neonDb } from "../db";
import { symbols, dailyBars, corporateActions, ingestionLog } from "../db/schema";
import type { Exchange } from "../lib/ingest/types";

function parseArgs() {
  const i = process.argv.indexOf("--exchange");
  const exchange = i === -1 ? undefined : (process.argv[i + 1] as Exchange);
  if (!exchange || (exchange !== "NSE" && exchange !== "BSE")) {
    throw new Error("--exchange NSE|BSE is required");
  }
  return { exchange };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const CHUNK_SIZE = 500;

async function main() {
  const { exchange } = parseArgs();

  console.log(`Copying ${exchange} symbols...`);
  const neonSymbols = await neonDb.select().from(symbols).where(eq(symbols.exchange, exchange));
  console.log(`  ${neonSymbols.length} symbols`);

  const localIdBySymbol = new Map<string, number>(); // neon id -> local id
  for (const batch of chunk(neonSymbols, CHUNK_SIZE)) {
    await localDb
      .insert(symbols)
      .values(
        batch.map((s) => ({
          exchange: s.exchange,
          symbol: s.symbol,
          series: s.series,
          isin: s.isin,
          name: s.name,
          isActive: s.isActive,
          firstSeen: s.firstSeen,
          lastSeen: s.lastSeen,
          isScanUniverse: s.isScanUniverse,
        }))
      )
      .onConflictDoUpdate({
        target: [symbols.exchange, symbols.symbol, symbols.series],
        set: { isin: sql`excluded.isin`, name: sql`excluded.name`, lastSeen: sql`excluded.last_seen` },
      });
  }

  const localSymbolRows = await localDb.select().from(symbols).where(eq(symbols.exchange, exchange));
  const localIdMap = new Map(localSymbolRows.map((s) => [`${s.symbol}|${s.series}`, s.id]));
  for (const s of neonSymbols) localIdBySymbol.set(String(s.id), localIdMap.get(`${s.symbol}|${s.series}`)!);

  console.log(`Copying ${exchange} daily_bars (this is the big one)...`);
  let totalCopied = 0;
  let skipped = 0;
  const failedSymbols: string[] = [];
  for (const [i, sym] of neonSymbols.entries()) {
    const localId = localIdBySymbol.get(String(sym.id));
    if (!localId) continue;

    try {
      // Resumability: a transient Neon HTTP hiccup killed this script mid-run
      // during testing (confirmed at symbol 1400/3288). Skip any symbol that
      // already has local bars so re-running only redoes what's missing.
      const [{ count: existingCount }] = await localDb
        .select({ count: sql<number>`count(*)::int` })
        .from(dailyBars)
        .where(eq(dailyBars.symbolId, localId));
      if (existingCount > 0) {
        skipped++;
        continue;
      }

      const bars = await neonDb.select().from(dailyBars).where(eq(dailyBars.symbolId, sym.id));
      if (bars.length === 0) continue;

      for (const batch of chunk(bars, CHUNK_SIZE)) {
        await localDb
          .insert(dailyBars)
          .values(batch.map((b) => ({ ...b, symbolId: localId })))
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
      totalCopied += bars.length;
    } catch (e) {
      console.error(`  [${i + 1}/${neonSymbols.length}] ${sym.symbol}: FAILED — ${(e as Error).message}`);
      failedSymbols.push(sym.symbol);
      continue;
    }
    if ((i + 1) % 200 === 0) console.log(`  [${i + 1}/${neonSymbols.length}] symbols, ${totalCopied} bars so far (${skipped} already done)`);
  }
  console.log(`  ${totalCopied} total daily_bars rows copied, ${skipped} symbols already done, skipped`);
  if (failedSymbols.length > 0) {
    console.log(`  ${failedSymbols.length} symbol(s) failed: ${failedSymbols.join(", ")}`);
    console.log("  re-run the same command to retry them — already-copied symbols are skipped");
  }

  console.log(`Copying ${exchange} corporate_actions...`);
  const actions = await neonDb.select().from(corporateActions);
  let actionsCopied = 0;
  for (const a of actions) {
    const localId = localIdBySymbol.get(String(a.symbolId));
    if (!localId) continue;
    await localDb.insert(corporateActions).values({ ...a, id: undefined, symbolId: localId }).onConflictDoNothing();
    actionsCopied++;
  }
  console.log(`  ${actionsCopied} corporate actions copied`);

  console.log(`Copying ${exchange} ingestion_log...`);
  const logs = await neonDb.select().from(ingestionLog).where(eq(ingestionLog.exchange, exchange));
  for (const batch of chunk(logs, CHUNK_SIZE)) {
    await localDb
      .insert(ingestionLog)
      .values(batch)
      .onConflictDoUpdate({
        target: [ingestionLog.exchange, ingestionLog.date],
        set: { status: sql`excluded.status`, rowsIngested: sql`excluded.rows_ingested`, completedAt: sql`excluded.completed_at` },
      });
  }
  console.log(`  ${logs.length} ingestion_log rows copied`);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
