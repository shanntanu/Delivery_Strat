import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";

/** Either backing store works identically for our query patterns — plain
 * insert/select/onConflictDoUpdate, no driver-specific features used. */
export type DbClient = NeonHttpDatabase<typeof schema> | NodePgDatabase<typeof schema>;
