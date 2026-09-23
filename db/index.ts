// The app (Next.js on Vercel) and anything reading the "live" liquid
// scan-universe subset should import from here. Full-archive tooling
// (backfill, corporate-action detection) should import `localDb` from
// `./local` instead — see db/local.ts and DATA_SOURCES.md.
export { db } from "./neon";
