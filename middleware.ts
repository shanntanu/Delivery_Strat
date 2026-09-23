import { NextResponse, type NextRequest } from "next/server";

// CLAUDE.md §12 point 7: "Protect write endpoints with an env-var shared
// secret." /admin is where every mutating action lives (corporate action
// confirm/correct/reject, manual-add, scan trigger) — Server Actions POST
// to the same route they're rendered on, so gating /admin gates all of
// them, page load included. If ADMIN_PASSWORD isn't set, this is a no-op
// (keeps local dev frictionless) — set it in Vercel's env vars for the
// deployed app.
export function middleware(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return NextResponse.next();

  const auth = request.headers.get("authorization");
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      const [, suppliedPassword] = decoded.split(":");
      if (suppliedPassword === password) return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
  });
}

export const config = {
  matcher: "/admin/:path*",
};
