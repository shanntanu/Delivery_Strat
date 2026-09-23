import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Neon's HTTP driver (over HTTPS) rather than raw TCP on 5432: this project's
// dev network blocks outbound 5432, and GitHub Actions runners / Vercel have
// no such restriction, but using the same driver everywhere keeps one code path.
const sql = neon(process.env.DATABASE_URL);
export const db = drizzle(sql, { schema });
