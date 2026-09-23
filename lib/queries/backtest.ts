import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { symbols, strategies } from "../../db/schema";

export interface StrategyOption {
  id: number;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  isTuned: boolean;
}

export interface BacktestPageData {
  symbolId: number;
  strategyOptions: StrategyOption[];
  dataFrom: string | null;
  dataTo: string | null;
  notFound: boolean;
}

export async function getBacktestPageData(exchange: string, symbol: string): Promise<BacktestPageData> {
  const [sym] = await db
    .select()
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange as "NSE" | "BSE"), eq(symbols.symbol, symbol)));

  if (!sym) return { symbolId: 0, strategyOptions: [], dataFrom: null, dataTo: null, notFound: true };

  const stratRows = await db.select().from(strategies).where(eq(strategies.symbolId, sym.id)).orderBy(desc(strategies.createdAt));

  return {
    symbolId: sym.id,
    strategyOptions: stratRows.map((r) => ({
      id: r.id,
      name: r.name,
      isDefault: r.isDefault,
      isActive: r.isActive,
      isTuned: !!r.tuning,
    })),
    dataFrom: sym.firstSeen,
    dataTo: sym.lastSeen,
    notFound: false,
  };
}
