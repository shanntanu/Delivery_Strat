// Trade simulation — CLAUDE.md §2.1 (entry/exit rules) and §8.1 (priority
// order, worst-case same-day resolution). Pure: bars + signal + execution
// params in, one simulated trade out.
import type { EngineBar, ExitReason, Signal, SimulatedTrade, StrategyParams } from "./types";

// India charges STT on delivery-based equity trades on both legs. CLAUDE.md's
// `costs.include_stt` is a boolean toggle with no rate specified in the
// schema, so this is a documented assumption, not a value from the spec.
const STT_BPS = 10; // 0.10%, current delivery-trade STT rate

function costFraction(costs: StrategyParams["costs"] | undefined): number {
  if (!costs) return 0;
  const stt = costs.include_stt ? STT_BPS : 0;
  return (costs.brokerage_bps + costs.slippage_bps + stt) / 10_000;
}

/**
 * Simulates one trade for a signal. Entry is the open of the day after the
 * signal (CLAUDE.md: "Entry is the open of the day after the signal
 * completes. Any function that can see the future gets a test proving it
 * doesn't."). Returns null if there isn't enough future data to enter at all.
 */
export function simulateTrade(
  bars: EngineBar[],
  signal: Pick<Signal, "signalIndex" | "signalDate">,
  execution: StrategyParams["execution"],
  costs?: StrategyParams["costs"]
): SimulatedTrade | null {
  const entryIndex = signal.signalIndex + 1;
  if (entryIndex >= bars.length) return null;

  const entryBar = bars[entryIndex];
  if (entryBar.open === null) return null;
  const entryPrice = entryBar.open;

  const fixedStopPrice = entryPrice * (1 - execution.stop_loss_pct / 100);
  const targetPrice = execution.target_pct !== null ? entryPrice * (1 + execution.target_pct / 100) : null;
  const useTrailing = execution.trailing_stop_pct !== null;

  let highestSinceEntry = entryBar.high ?? entryPrice;
  let exitIndex = -1;
  let exitReason: ExitReason = "time_exit";
  let exitPrice = entryPrice;

  const lastPossibleIndex = Math.min(entryIndex + execution.hold_days - 1, bars.length - 1);

  for (let k = entryIndex; k <= lastPossibleIndex; k++) {
    const bar = bars[k];
    if (bar.high !== null) highestSinceEntry = Math.max(highestSinceEntry, bar.high);

    const stopPrice = useTrailing
      ? highestSinceEntry * (1 - (execution.trailing_stop_pct as number) / 100)
      : fixedStopPrice;

    const stopTriggered = bar.low !== null && bar.low <= stopPrice;
    const targetTriggered = targetPrice !== null && bar.high !== null && bar.high >= targetPrice;

    if (stopTriggered) {
      // Both triggering the same day resolves to the worse outcome — stop
      // wins over target. CLAUDE.md §8.1: "silent optimism here is how
      // backtests lie."
      exitIndex = k;
      exitReason = useTrailing ? "trailing_stop" : "stop_loss";
      exitPrice = stopPrice;
      break;
    }
    if (targetTriggered) {
      exitIndex = k;
      exitReason = "target";
      exitPrice = targetPrice as number;
      break;
    }
  }

  if (exitIndex === -1) {
    // No stop/target hit within the hold — time exit at the close of the
    // last held day (which may be short of hold_days if data runs out).
    exitIndex = lastPossibleIndex;
    exitReason = "time_exit";
    exitPrice = bars[exitIndex].close ?? entryPrice;
  }

  const barsHeld = exitIndex - entryIndex + 1;
  const grossReturn = (exitPrice / entryPrice - 1) * 100;

  const cost = costFraction(costs);
  const effectiveEntry = entryPrice * (1 + cost);
  const effectiveExit = exitPrice * (1 - cost);
  const realizedReturn = (effectiveExit / effectiveEntry - 1) * 100;

  // MFE/MAE are reported over the full hold_days window regardless of when
  // the simulated trade actually exited — "how much upside/downside was on
  // the table in the 10 days following entry," independent of the stop.
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let k = entryIndex; k <= lastPossibleIndex; k++) {
    if (bars[k].high !== null) maxHigh = Math.max(maxHigh, bars[k].high as number);
    if (bars[k].low !== null) minLow = Math.min(minLow, bars[k].low as number);
  }
  const mfe = maxHigh === -Infinity ? 0 : (maxHigh / entryPrice - 1) * 100;
  const mae = minLow === Infinity ? 0 : (minLow / entryPrice - 1) * 100;

  const fwdReturn = (n: number): number | null => {
    const idx = entryIndex + n - 1;
    if (idx >= bars.length || bars[idx].close === null) return null;
    return ((bars[idx].close as number) / entryPrice - 1) * 100;
  };

  return {
    signalDate: signal.signalDate,
    entryDate: entryBar.date,
    entryPrice,
    exitDate: bars[exitIndex].date,
    exitPrice,
    exitReason,
    barsHeld,
    grossReturn,
    realizedReturn,
    mfe,
    mae,
    fwd1: fwdReturn(1),
    fwd3: fwdReturn(3),
    fwd5: fwdReturn(5),
    fwd10: fwdReturn(10),
    fwd20: fwdReturn(20),
  };
}
