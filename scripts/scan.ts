// Scan runner CLI — CLAUDE.md build order Phase 5. Thin wrapper around
// lib/scan-runner.ts, which is shared with the Admin page's scan-trigger
// action so there's exactly one implementation.
//
// Usage:
//   npm run scan -- --exchange NSE
//   npm run scan -- --exchange BSE --db local   (dry-run against the full local archive)
import "dotenv/config";
import { db as neonDb } from "../db";
import { runScan } from "../lib/scan-runner";
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
  // Lazy: db/local.ts throws at import when LOCAL_DATABASE_URL is unset (always
  // the case on GitHub Actions) — see the same note in scripts/tune.ts.
  const db: DbClient = target === "local" ? (await import("../db/local")).localDb : neonDb;
  console.log(`Scanning ${exchange} against ${target}`);

  const summary = await runScan(db, exchange, (p) => {
    if (p.signalCount > 0) console.log(`[${p.index}/${p.total}] ${p.symbol}: ${p.signalCount} signal(s)`);
  });

  console.log(
    `\nDone. universe=${summary.universeSize} symbolsWithSignals=${summary.symbolsWithSignals} totalSignals=${summary.totalSignals}`
  );
  if (summary.failed.length > 0) {
    console.log(`${summary.failed.length} symbol(s) failed: ${summary.failed.join(", ")}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
