// Tuner CLI — CLAUDE.md §9 / Phase 9. Thin wrapper around
// lib/tuner-runner.ts, which is shared with the Admin page's tuner-trigger
// action, mirroring scripts/scan.ts.
//
// Usage:
//   npm run tune -- --exchange NSE
//   npm run tune -- --exchange BSE --db local   (dry-run against the full local archive)
//
// Run this AFTER the scan has created a default strategy for each symbol —
// the tuner has nothing to tune otherwise (see tuneSymbol's early-return in
// lib/tuner-runner.ts).
import "dotenv/config";
import { localDb } from "../db/local";
import { db as neonDb } from "../db";
import { runTuner } from "../lib/tuner-runner";
import type { DbClient } from "../lib/ingest/db-client";
import type { Exchange } from "../lib/ingest/types";

function parseArgs() {
  const i = process.argv.indexOf("--exchange");
  const exchange = i === -1 ? undefined : (process.argv[i + 1] as Exchange);
  if (!exchange || (exchange !== "NSE" && exchange !== "BSE")) {
    throw new Error("--exchange NSE|BSE is required");
  }
  const dbIdx = process.argv.indexOf("--db");
  const target = (dbIdx === -1 ? "neon" : process.argv[dbIdx + 1]) as "local" | "neon";
  return { exchange, target };
}

async function main() {
  const { exchange, target } = parseArgs();
  const db: DbClient = target === "local" ? localDb : neonDb;
  console.log(`Tuning ${exchange} against ${target}`);

  const summary = await runTuner(db, exchange, (p) => {
    if (p.status !== "skipped") console.log(`[${p.index}/${p.total}] ${p.symbol}: ${p.status}`);
  });

  console.log(
    `\nDone. universe=${summary.universeSize} tuned=${summary.symbolsTuned} noPattern=${summary.symbolsNoPattern} skipped=${summary.symbolsSkipped}`
  );
  if (summary.failed.length > 0) {
    console.log(`${summary.failed.length} symbol(s) failed: ${summary.failed.join(", ")}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
