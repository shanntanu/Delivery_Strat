import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { symbols, strategies } from "../../db/schema";
import { DEFAULT_STRATEGY_PARAMS } from "../engine/types";
import type { StrategyParams } from "../engine/types";

export interface StrategyHistoryRow {
  id: number;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  medianReturn: number | null;
  signalCount: number | null;
}

export interface StrategyEditorData {
  symbolId: number;
  defaultParams: StrategyParams;
  /** The params the editor should start from: the active custom strategy if
   * one exists, else the default. */
  startingParams: StrategyParams;
  history: StrategyHistoryRow[];
  notFound: boolean;
}

export async function getStrategyEditorData(exchange: string, symbol: string): Promise<StrategyEditorData> {
  const [sym] = await db
    .select()
    .from(symbols)
    .where(and(eq(symbols.exchange, exchange as "NSE" | "BSE"), eq(symbols.symbol, symbol)));

  if (!sym) {
    return { symbolId: 0, defaultParams: DEFAULT_STRATEGY_PARAMS, startingParams: DEFAULT_STRATEGY_PARAMS, history: [], notFound: true };
  }

  const rows = await db
    .select()
    .from(strategies)
    .where(eq(strategies.symbolId, sym.id))
    .orderBy(desc(strategies.createdAt));

  const defaultRow = rows.find((r) => r.isDefault);
  const activeCustom = rows.find((r) => !r.isDefault && r.isActive);
  const starting = (activeCustom?.params ?? defaultRow?.params ?? DEFAULT_STRATEGY_PARAMS) as StrategyParams;

  return {
    symbolId: sym.id,
    defaultParams: (defaultRow?.params as StrategyParams | undefined) ?? DEFAULT_STRATEGY_PARAMS,
    startingParams: starting,
    history: rows.map((r) => ({
      id: r.id,
      name: r.name,
      isDefault: r.isDefault,
      isActive: r.isActive,
      createdAt: r.createdAt.toString(),
      medianReturn: null,
      signalCount: null,
    })),
    notFound: false,
  };
}
