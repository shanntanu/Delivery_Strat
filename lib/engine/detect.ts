// Signal detection — CLAUDE.md §2.1. Pure: bars + params in, signals out.
//
// A signal on day t requires ALL of, over the window [t-window_days+1, t]:
//   - every day's delivery/baseline >= min_ratio_each_day (sustained, not spiky)
//   - the window's mean delivery/baseline within [avg_ratio_min, avg_ratio_max]
//     (CLAUDE.md §2.2: the cap is load-bearing — extreme surges perform worse)
//   - the window's mean trades/baseline >= trades.min_avg_ratio (if enabled)
//   - cumulative price change within [cum_change_min_pct, cum_change_max_pct]
//   - at least min_up_days up-days in the window
//   - close above every SMA in require_above_sma
// Baselines are computed strictly before the window (baseline.ts) — this is
// what keeps the detector free of look-ahead bias.
import { computeBaseline, median } from "./baseline";
import { sma } from "./indicators";
import type { EngineBar, Signal, StrategyParams } from "./types";

export function detectSignals(bars: EngineBar[], params: StrategyParams): Signal[] {
  const closes = bars.map((b) => b.close);
  const deliveries = bars.map((b) => b.deliveryQty);
  const trades = bars.map((b) => b.trades);
  const turnovers = bars.map((b) => b.turnover);

  const { window_days: windowDays } = params;
  const { lookback_days: lookbackDays, method: baselineMethod } = params.baseline;

  const raw: Signal[] = [];

  for (let i = 0; i < bars.length; i++) {
    const windowStart = i - windowDays + 1;
    if (windowStart < 1) continue; // need a prior-day prevClose reference too

    const today = bars[i];
    if (today.close === null) continue;

    // --- SMA filter (also gates on having enough history) ---
    let aboveAllSmas = true;
    for (const n of params.price.require_above_sma) {
      const s = sma(closes, n, i);
      if (s === null || today.close <= s) {
        aboveAllSmas = false;
        break;
      }
    }
    if (!aboveAllSmas) continue;

    // --- delivery baseline & per-day ratios ---
    const baselineDelivery = computeBaseline(deliveries, i, windowDays, lookbackDays, baselineMethod);
    if (baselineDelivery === null || baselineDelivery <= 0) continue;

    const windowIndices = Array.from({ length: windowDays }, (_, k) => windowStart + k);
    const deliveryRatios: number[] = [];
    let everyDayClearsMinRatio = true;
    for (const j of windowIndices) {
      const q = deliveries[j];
      if (q === null) {
        everyDayClearsMinRatio = false;
        break;
      }
      const ratio = q / baselineDelivery;
      if (ratio < params.delivery.min_ratio_each_day) {
        everyDayClearsMinRatio = false;
        break;
      }
      deliveryRatios.push(ratio);
    }
    if (!everyDayClearsMinRatio) continue;

    const avgRatio = deliveryRatios.reduce((a, b) => a + b, 0) / deliveryRatios.length;
    if (avgRatio < params.delivery.avg_ratio_min || avgRatio > params.delivery.avg_ratio_max) continue;
    const minRatio = Math.min(...deliveryRatios);

    // --- trades filter (average only, not per-day) ---
    let tradesRatio: number | null = null;
    if (params.trades.enabled) {
      const baselineTrades = computeBaseline(trades, i, windowDays, lookbackDays, baselineMethod);
      if (baselineTrades === null || baselineTrades <= 0) continue;
      const tradeRatios: (number | null)[] = windowIndices.map((j) =>
        trades[j] === null ? null : (trades[j] as number) / baselineTrades
      );
      if (tradeRatios.some((r) => r === null)) continue;
      tradesRatio = (tradeRatios as number[]).reduce((a, b) => a + b, 0) / tradeRatios.length;
      if (tradesRatio < params.trades.min_avg_ratio) continue;
    }

    // --- price filter ---
    const refClose = bars[windowStart].prevClose;
    if (refClose === null || refClose <= 0) continue;
    const priceChangePct = ((today.close - refClose) / refClose) * 100;
    if (priceChangePct < params.price.cum_change_min_pct || priceChangePct > params.price.cum_change_max_pct) {
      continue;
    }

    const upDays = windowIndices.filter((j) => {
      const bar = bars[j];
      return bar.close !== null && bar.prevClose !== null && bar.close > bar.prevClose;
    }).length;
    if (upDays < params.price.min_up_days) continue;

    // --- liquidity filter: 20-day median turnover, CLAUDE.md §4.3 ---
    const baselineTurnover = computeBaseline(turnovers, i, windowDays, lookbackDays, "median");
    if (baselineTurnover === null) continue;
    if (baselineTurnover / 1e7 < params.filters.min_avg_turnover_cr) continue;

    // --- optional delivery% gate (disabled by default — CLAUDE.md §2.3) ---
    const deliveryPcts = windowIndices.map((j) => bars[j].deliveryPct).filter((v): v is number => v !== null);
    const avgDeliveryPct = deliveryPcts.length > 0 ? deliveryPcts.reduce((a, b) => a + b, 0) / deliveryPcts.length : null;
    if (params.filters.min_delivery_pct !== null) {
      if (avgDeliveryPct === null || avgDeliveryPct < params.filters.min_delivery_pct) continue;
    }

    raw.push({
      signalDate: today.date,
      windowStart: bars[windowStart].date,
      windowEnd: today.date,
      avgRatio,
      minRatio,
      tradesRatio,
      priceChangePct,
      upDays,
      avgDeliveryPct,
      baselineDelivery,
      baselineTrades: params.trades.enabled ? computeBaseline(trades, i, windowDays, lookbackDays, baselineMethod) : null,
      signalIndex: i,
    });
  }

  return applyCooldown(raw, params.execution.cooldown_days);
}

// Cooldown is measured in trading days (bar-index distance), not calendar
// days — a weekend between two candidates shouldn't count against it.
function applyCooldown(signals: Signal[], cooldownDays: number): Signal[] {
  if (cooldownDays <= 0) return signals;
  const kept: Signal[] = [];
  let lastKeptIndex: number | null = null;
  for (const s of signals) {
    if (lastKeptIndex !== null && s.signalIndex - lastKeptIndex < cooldownDays) {
      continue;
    }
    kept.push(s);
    lastKeptIndex = s.signalIndex;
  }
  return kept;
}

// re-exported for tune.ts / metrics.ts convenience
export { median };
