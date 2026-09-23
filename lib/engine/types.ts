// Analysis engine types. Everything downstream of these is pure — no DB, no
// network, no clock reads (CLAUDE.md §8).

/** One symbol's bar, already corporate-action adjusted (or raw, for a symbol
 * with no actions) — the engine never knows or cares which. */
export interface EngineBar {
  date: string; // YYYY-MM-DD
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  last: number | null;
  close: number | null;
  vwap: number | null;
  volume: number | null;
  turnover: number | null;
  trades: number | null;
  deliveryQty: number | null;
  deliveryPct: number | null;
}

// Mirrors CLAUDE.md §7's strategy JSON schema exactly.
export interface StrategyParams {
  schema_version: 1;
  window_days: number;
  baseline: {
    lookback_days: number;
    method: "median" | "mean";
    exclude_window: boolean;
  };
  delivery: {
    min_ratio_each_day: number;
    avg_ratio_min: number;
    avg_ratio_max: number;
  };
  trades: {
    min_avg_ratio: number;
    enabled: boolean;
  };
  price: {
    cum_change_min_pct: number;
    cum_change_max_pct: number;
    min_up_days: number;
    require_above_sma: number[];
  };
  filters: {
    min_delivery_pct: number | null;
    min_avg_turnover_cr: number;
  };
  execution: {
    entry: "next_open" | "signal_close";
    hold_days: number;
    stop_loss_pct: number;
    target_pct: number | null;
    trailing_stop_pct: number | null;
    cooldown_days: number;
  };
  costs: {
    brokerage_bps: number;
    slippage_bps: number;
    include_stt: boolean;
  };
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  schema_version: 1,
  window_days: 4,
  baseline: { lookback_days: 20, method: "median", exclude_window: true },
  delivery: { min_ratio_each_day: 1.3, avg_ratio_min: 1.5, avg_ratio_max: 3.5 },
  trades: { min_avg_ratio: 1.3, enabled: true },
  price: { cum_change_min_pct: 3, cum_change_max_pct: 12, min_up_days: 3, require_above_sma: [20, 50] },
  filters: { min_delivery_pct: null, min_avg_turnover_cr: 1.0 },
  execution: {
    entry: "next_open",
    hold_days: 10,
    stop_loss_pct: 7,
    target_pct: null,
    trailing_stop_pct: null,
    cooldown_days: 10,
  },
  costs: { brokerage_bps: 3, slippage_bps: 15, include_stt: true },
};

export interface Signal {
  signalDate: string;
  windowStart: string;
  windowEnd: string;
  avgRatio: number;
  minRatio: number;
  tradesRatio: number | null;
  priceChangePct: number;
  upDays: number;
  avgDeliveryPct: number | null;
  baselineDelivery: number | null;
  baselineTrades: number | null;
  /** Index into the bars array of the signal day (window end). Used by
   * simulate.ts to find the entry bar without re-searching by date. */
  signalIndex: number;
}

export type ExitReason = "stop_loss" | "target" | "trailing_stop" | "time_exit";

export interface SimulatedTrade {
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  exitReason: ExitReason;
  barsHeld: number;
  /** Gross return, before costs. */
  grossReturn: number;
  /** Net of brokerage/slippage/STT if costs were supplied, else equals grossReturn. */
  realizedReturn: number;
  mfe: number; // max favorable excursion, positive %
  mae: number; // max adverse excursion, negative %
  fwd1: number | null;
  fwd3: number | null;
  fwd5: number | null;
  fwd10: number | null;
  fwd20: number | null;
}
