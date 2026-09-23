// One-off: apply a drizzle-kit generated .sql migration via the Neon HTTP
// driver, because drizzle-kit's own push/migrate commands use a raw TCP
// postgres driver, and outbound TCP:5432 is blocked on this dev network.
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/apply-migration.ts <path-to-sql>");
  process.exit(1);
}

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const raw = readFileSync(file, "utf-8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Applying ${statements.length} statements from ${file}`);
  for (const stmt of statements) {
    console.log("---");
    console.log(stmt.slice(0, 100).replace(/\s+/g, " ") + "...");
    await sql.query(stmt);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
