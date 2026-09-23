import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  bigint,
  numeric,
  text,
  boolean,
  date,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const exchangeEnum = pgEnum("exchange", ["NSE", "BSE"]);
export const corporateActionTypeEnum = pgEnum("corporate_action_type", [
  "split",
  "bonus",
  "consolidation",
]);
export const corporateActionSourceEnum = pgEnum("corporate_action_source", [
  "detected",
  "manual",
]);
export const exitReasonEnum = pgEnum("exit_reason", [
  "stop_loss",
  "target",
  "trailing_stop",
  "time_exit",
]);
export const scanRunStatusEnum = pgEnum("scan_run_status", [
  "running",
  "completed",
  "failed",
]);
// scan_runs is shared by three batch jobs (Phase 9's tuner and the
// liquid-universe recompute reuse it rather than each getting their own
// near-identical table — universeSize/symbolsWithSignals are repurposed
// per type; see lib/tuner-runner.ts and scripts/compute-liquid-universe.ts).
export const runTypeEnum = pgEnum("run_type", ["scan", "tune", "universe"]);
export const ingestionStatusEnum = pgEnum("ingestion_status", [
  "pending",
  "success",
  "failed",
  "no_data",
]);

// --- symbols ---------------------------------------------------------------

export const symbols = pgTable(
  "symbols",
  {
    id: serial("id").primaryKey(),
    exchange: exchangeEnum("exchange").notNull(),
    symbol: text("symbol").notNull(),
    isin: text("isin"),
    name: text("name"),
    series: text("series").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    firstSeen: date("first_seen").notNull(),
    lastSeen: date("last_seen").notNull(),
    // Whether this symbol meets CLAUDE.md §4.3's default scan-universe
    // liquidity bar (20-day median turnover > configured threshold). Neon
    // (free tier, storage-constrained — see DATA_SOURCES.md) only stores
    // daily_bars for symbols where this is true; the full raw universe lives
    // in a local Postgres instance instead. Computed periodically by
    // scripts/compute-liquid-universe.ts, not on every ingest.
    isScanUniverse: boolean("is_scan_universe").notNull().default(false),
  },
  (t) => [
    uniqueIndex("symbols_exchange_symbol_series_unique").on(
      t.exchange,
      t.symbol,
      t.series
    ),
    index("symbols_isin_idx").on(t.isin),
  ]
);

// --- daily_bars --------------------------------------------------------------
// Raw bars as published by the exchange. Never adjusted in place — corporate
// action adjustment happens in the engine's data loader (see lib/engine).

export const dailyBars = pgTable(
  "daily_bars",
  {
    symbolId: integer("symbol_id")
      .notNull()
      .references(() => symbols.id),
    date: date("date").notNull(),
    prevClose: numeric("prev_close", { precision: 14, scale: 4 }),
    open: numeric("open", { precision: 14, scale: 4 }),
    high: numeric("high", { precision: 14, scale: 4 }),
    low: numeric("low", { precision: 14, scale: 4 }),
    last: numeric("last", { precision: 14, scale: 4 }),
    close: numeric("close", { precision: 14, scale: 4 }),
    vwap: numeric("vwap", { precision: 14, scale: 4 }),
    volume: bigint("volume", { mode: "number" }),
    turnover: numeric("turnover", { precision: 18, scale: 2 }),
    trades: bigint("trades", { mode: "number" }),
    deliveryQty: bigint("delivery_qty", { mode: "number" }),
    deliveryPct: numeric("delivery_pct", { precision: 5, scale: 2 }),
  },
  (t) => [
    primaryKey({ columns: [t.symbolId, t.date] }),
    index("daily_bars_date_idx").on(t.date),
  ]
);

// --- corporate_actions -------------------------------------------------------

export const corporateActions = pgTable("corporate_actions", {
  id: serial("id").primaryKey(),
  symbolId: integer("symbol_id")
    .notNull()
    .references(() => symbols.id),
  exDate: date("ex_date").notNull(),
  type: corporateActionTypeEnum("type").notNull(),
  ratioNumerator: integer("ratio_numerator").notNull(),
  ratioDenominator: integer("ratio_denominator").notNull(),
  adjFactor: numeric("adj_factor", { precision: 10, scale: 6 }).notNull(),
  source: corporateActionSourceEnum("source").notNull(),
  confirmed: boolean("confirmed").notNull().default(false),
  notes: text("notes"),
});

// --- strategies ----------------------------------------------------------------

export const strategies = pgTable(
  "strategies",
  {
    id: serial("id").primaryKey(),
    symbolId: integer("symbol_id")
      .notNull()
      .references(() => symbols.id),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    params: jsonb("params").notNull(),
    tuning: jsonb("tuning"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("strategies_symbol_id_idx").on(t.symbolId),
    // At most one default strategy per symbol. Added after a real race
    // surfaced in production data: ensureDefaultStrategy's check-then-insert
    // (SELECT existing, INSERT if none) isn't safe against Neon's HTTP
    // driver, where each query is a separate connection with no read-after-
    // write guarantee — a retried scan created a second is_default=true row
    // for 28 symbols. This constraint makes that impossible going forward;
    // the application code was also fixed to use ON CONFLICT instead of
    // check-then-insert.
    uniqueIndex("strategies_one_default_per_symbol")
      .on(t.symbolId)
      .where(sql`is_default = true`),
  ]
);

// --- signals -----------------------------------------------------------------

export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    symbolId: integer("symbol_id")
      .notNull()
      .references(() => symbols.id),
    strategyId: integer("strategy_id")
      .notNull()
      .references(() => strategies.id),
    signalDate: date("signal_date").notNull(),
    windowStart: date("window_start").notNull(),
    windowEnd: date("window_end").notNull(),
    avgRatio: numeric("avg_ratio", { precision: 8, scale: 4 }),
    minRatio: numeric("min_ratio", { precision: 8, scale: 4 }),
    tradesRatio: numeric("trades_ratio", { precision: 8, scale: 4 }),
    priceChangePct: numeric("price_change_pct", { precision: 8, scale: 4 }),
    upDays: integer("up_days"),
    avgDeliveryPct: numeric("avg_delivery_pct", { precision: 5, scale: 2 }),
    baselineDelivery: bigint("baseline_delivery", { mode: "number" }),
    baselineTrades: bigint("baseline_trades", { mode: "number" }),
    entryPrice: numeric("entry_price", { precision: 14, scale: 4 }),
    fwd1: numeric("fwd_1", { precision: 8, scale: 4 }),
    fwd3: numeric("fwd_3", { precision: 8, scale: 4 }),
    fwd5: numeric("fwd_5", { precision: 8, scale: 4 }),
    fwd10: numeric("fwd_10", { precision: 8, scale: 4 }),
    fwd20: numeric("fwd_20", { precision: 8, scale: 4 }),
    mfe10: numeric("mfe_10", { precision: 8, scale: 4 }),
    mae10: numeric("mae_10", { precision: 8, scale: 4 }),
    exitReason: exitReasonEnum("exit_reason"),
    realizedReturn: numeric("realized_return", { precision: 8, scale: 4 }),
  },
  (t) => [
    index("signals_symbol_id_signal_date_idx").on(t.symbolId, t.signalDate),
    // Lets the scan runner upsert idempotently — re-scanning a symbol
    // refreshes its signals in place instead of accumulating duplicates.
    uniqueIndex("signals_symbol_strategy_date_unique").on(t.symbolId, t.strategyId, t.signalDate),
  ]
);

// --- scan_runs -----------------------------------------------------------------

export const scanRuns = pgTable("scan_runs", {
  id: serial("id").primaryKey(),
  runType: runTypeEnum("run_type").notNull().default("scan"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  universeSize: integer("universe_size"),
  symbolsWithSignals: integer("symbols_with_signals"),
  paramsSnapshot: jsonb("params_snapshot"),
  status: scanRunStatusEnum("status").notNull().default("running"),
  error: text("error"),
});

// --- backtests -----------------------------------------------------------------

export const backtests = pgTable("backtests", {
  id: serial("id").primaryKey(),
  symbolId: integer("symbol_id")
    .notNull()
    .references(() => symbols.id),
  strategyId: integer("strategy_id")
    .notNull()
    .references(() => strategies.id),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  params: jsonb("params").notNull(),
  metrics: jsonb("metrics").notNull(),
  equityCurve: jsonb("equity_curve"),
  trades: jsonb("trades"),
});

// --- ingestion_log ---------------------------------------------------------------

export const ingestionLog = pgTable(
  "ingestion_log",
  {
    exchange: exchangeEnum("exchange").notNull(),
    date: date("date").notNull(),
    status: ingestionStatusEnum("status").notNull(),
    rowsIngested: integer("rows_ingested"),
    error: text("error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.exchange, t.date] })]
);
