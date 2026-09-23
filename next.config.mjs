/** @type {import('next').NextConfig} */
const nextConfig = {
  // Without this, Next.js's Server Components bundler patches/bundles
  // @neondatabase/serverless in a way that broke its own TLS handling
  // during dev — every query failed with "self-signed certificate in
  // certificate chain" against Neon specifically, while every plain
  // node/tsx script (scan.ts, backfill.ts, etc.) never hit this all
  // session. Marking it external keeps it running as real, unbundled
  // Node code instead.
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default nextConfig;
