import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Full raw archive of every ingested symbol (no liquidity filtering) — lives
// on this machine, not on Neon. See DATA_SOURCES.md: Neon's free tier
// (512MB) can't hold the full NSE+BSE universe, so only the liquid
// scan-universe subset (CLAUDE.md §4.3) is promoted to Neon; this local DB
// is the complete source of truth for offline research.
if (!process.env.LOCAL_DATABASE_URL) {
  throw new Error("LOCAL_DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: process.env.LOCAL_DATABASE_URL });
export const localDb = drizzle(pool, { schema });
