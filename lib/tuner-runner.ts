// Per-symbol tuner orchestration — CLAUDE.md §9. Shared by scripts/tune.ts
// (CLI) and the Admin page's tuner-trigger action, mirroring lib/scan-runner.ts.
//
// What "tuning a symbol" means here, concretely (this is an implementation
// decision CLAUDE.md §9 doesn't spell out, recorded here rather than left
// implicit): there is exactly one strategy row per symbol with
// is_default = true (enforced by a DB constraint — see db/schema.ts). Tuning
// does not create a second row; it OVERWRITES that row's params with the
// best grid cell found, renames it "Tuned", and records the full diagnostic
// trail in its `tuning` jsonb column. If no cell clears the reliability bar
// (§9.1), the row is left at (or reverted to) DEFAULT_STRATEGY_PARAMS named
// "Default", with tuning recording status "no_reliable_pattern" — so a
// symbol that stops qualifying on a later re-tune correctly falls back
// instead of keeping stale tuned params. Either way, the symbol's persisted
// `signals` are recomputed for whichever params are now current, so the
// scan/backtest/dashboard queries — which all just read "the default
// strategy" — see consistent results without needing to know tuning
// happened at all.
import { and, eq } from "drizzle-orm";
import { symbols, strategies, scanRuns } from "../db/schema";
import { getAdjustedBarsFrom } from "./corporate-actions/loader";
import { persistSignals } from "./signal-persistence";
import { tuneStrategy } from "./engine/tune";
import { permutationTest, computeBasicMetrics } from "./engine/metrics";
import { DEFAULT_STRATEGY_PARAMS } from "./engine/types";
import { withRetry } from "./ingest/retry";
import { mapWithConcurrency } from "./concurrency";
import type { DbClient } from "./ingest/db-client";
import type { Exchange } from "./ingest/types";
import type { StrategyParams } from "./engine/types";

const TUNE_CONCURRENCY = 4; // lower than the scan's — each symbol here runs a ~162-cell grid search, not one param set
const MIN_BARS_FOR_TUNING = 250; // needs enough history either side of the 70/30 split to mean anything
const PERMUTATION_ITERATIONS = 5000; // CLAUDE.md §8.2: ">=5000 iterations"

export interface TuningRecord {
  status: "tuned" | "no_reliable_pattern";
  combinationsSearched: number;
  pValue?: number;
  oosAgrees?: boolean;
  oosSignFlip?: boolean;
  trainSignalCount?: number;
  trainMedianReturn?: number | null;
  testSignalCount?: number;
  testMedianReturn?: number | null;
  splitDate?: string;
  tunedAt: string;
}

async function tuneSymbol(db: DbClient, symbolId: number): Promise<"tuned" | "no_reliable_pattern" | "skipped"> {
  const { bars } = await getAdjustedBarsFrom(db, symbolId);
  if (bars.length < MIN_BARS_FOR_TUNING) return "skipped";

  const [existing] = await db
    .select({ id: strategies.id })
    .from(strategies)
    .where(and(eq(strategies.symbolId, symbolId), eq(strategies.isDefault, true)));
  if (!existing) return "skipped"; // scan hasn't run for this symbol yet — nothing to tune

  const result = tuneStrategy(bars);
  const tunedAt = new Date().toISOString();

  let params: StrategyParams;
  let name: string;
  let tuning: TuningRecord;

  if (result.status === "no_reliable_pattern") {
    params = DEFAULT_STRATEGY_PARAMS;
    name = "Default";
    tuning = { status: "no_reliable_pattern", combinationsSearched: result.combinationsSearched, tunedAt };
  } else {
    params = result.bestParams!;
    name = "Tuned";
    // p-value for the badge (CLAUDE.md §10.1) is computed against the FULL
    // history under the tuned params, not just the training split — the
    // question the badge answers is "is this pattern real for this symbol",
    // not "did the search overfit the training slice" (that's oosSignFlip's job).
    const trades = (await persistSignals(db, symbolId, existing.id, bars, params)).trades;
    const metrics = computeBasicMetrics(trades);
    const pValue =
      trades.length > 0
        ? permutationTest(bars, metrics.meanReturn ?? 0, trades.length, params.execution, params.costs, PERMUTATION_ITERATIONS)
        : 1;
    tuning = {
      status: "tuned",
      combinationsSearched: result.combinationsSearched,
      pValue,
      oosAgrees: !result.oosSignFlip,
      oosSignFlip: result.oosSignFlip,
      trainSignalCount: result.trainSignalCount,
      trainMedianReturn: result.trainMedianReturn,
      testSignalCount: result.testSignalCount,
      testMedianReturn: result.testMedianReturn,
      splitDate: result.splitDate,
      tunedAt,
    };

    await db
      .update(strategies)
      .set({ name, params, tuning, updatedAt: new Date() })
      .where(eq(strategies.id, existing.id));
    return "tuned";
  }

  // no_reliable_pattern branch: revert params/name if a previous run had
  // tuned this symbol, and refresh signals under the (possibly reverted) params.
  await persistSignals(db, symbolId, existing.id, bars, params);
  await db
    .update(strategies)
    .set({ name, params, tuning, updatedAt: new Date() })
    .where(eq(strategies.id, existing.id));
  return "no_reliable_pattern";
}

export interface TuneProgress {
  index: number;
  total: number;
  symbol: string;
  status: "tuned" | "no_reliable_pattern" | "skipped";
}

export interface TuneSummary {
  runId: number;
  universeSize: number;
  symbolsTuned: number;
  symbolsNoPattern: number;
  symbolsSkipped: number;
  failed: string[];
}

export async function runTuner(
  db: DbClient,
  exchange: Exchange,
  onProgress?: (p: TuneProgress) => void
): Promise<TuneSummary> {
  const [run] = await withRetry(() =>
    db
      .insert(scanRuns)
      .values({ runType: "tune", startedAt: new Date(), status: "running" })
      .returning()
  );

  try {
    const symbolRows = await withRetry(() =>
      db
        .select({ id: symbols.id, symbol: symbols.symbol })
        .from(symbols)
        .where(and(eq(symbols.exchange, exchange), eq(symbols.isScanUniverse, true)))
    );

    let symbolsTuned = 0;
    let symbolsNoPattern = 0;
    let symbolsSkipped = 0;
    const failed: string[] = [];
    let completed = 0;

    await mapWithConcurrency(symbolRows, TUNE_CONCURRENCY, async (sym) => {
      try {
        const status = await withRetry(() => tuneSymbol(db, sym.id));
        if (status === "tuned") symbolsTuned++;
        else if (status === "no_reliable_pattern") symbolsNoPattern++;
        else symbolsSkipped++;
        completed++;
        onProgress?.({ index: completed, total: symbolRows.length, symbol: sym.symbol, status });
      } catch (e) {
        completed++;
        failed.push(sym.symbol);
      }
    });

    await withRetry(async () => {
      await db
        .update(scanRuns)
        .set({ finishedAt: new Date(), universeSize: symbolRows.length, symbolsWithSignals: symbolsTuned, status: "completed" })
        .where(eq(scanRuns.id, run.id));
    });

    return { runId: run.id, universeSize: symbolRows.length, symbolsTuned, symbolsNoPattern, symbolsSkipped, failed };
  } catch (e) {
    try {
      await withRetry(async () => {
        await db
          .update(scanRuns)
          .set({ finishedAt: new Date(), status: "failed", error: (e as Error).message })
          .where(eq(scanRuns.id, run.id));
      });
    } catch {
      // best-effort, see backfill.ts's identical pattern
    }
    throw e;
  }
}
