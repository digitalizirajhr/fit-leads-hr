import { NextResponse, type NextRequest } from "next/server";

/**
 * On Vercel, redirect /scrape → /leads.
 *
 * Why: a full Croatia scrape takes 5–15 minutes, well past Vercel's function
 * timeout (10s Hobby / 60s Pro / 300s Pro Plus). The /api/scrape route also
 * 403s when VERCEL=1 — this middleware just stops the user from reaching the
 * form in the first place. Locally (no VERCEL env var), this is a no-op.
 */
export function middleware(req: NextRequest) {
  if (process.env.VERCEL === "1" && req.nextUrl.pathname.startsWith("/scrape")) {
    return NextResponse.redirect(new URL("/leads", req.url));
  }
  return NextResponse.next();
}

// Only run on /scrape — keeps middleware overhead off every other request.
export const config = {
  matcher: ["/scrape/:path*"],
};
