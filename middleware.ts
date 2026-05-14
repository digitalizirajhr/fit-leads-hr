import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const ALLOWED_DOMAIN = "@digitaliziraj.hr";

/**
 * Auth gate. Every non-static request goes through here.
 *
 * Rules:
 *   - /login, /auth/* → public (sign-in flow)
 *   - Everything else → require a valid Supabase session whose user.email
 *     ends with @digitaliziraj.hr
 *   - API routes (/api/*) get JSON 401/403; pages get redirected to /login
 *
 * The domain re-check here is defense in depth — /auth/callback already
 * enforces it on first sign-in. If a session somehow exists for the wrong
 * domain (e.g. cookie crafted manually), middleware also blocks.
 */
export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Public allowlist. Done FIRST so a misconfigured Supabase env var can't
  // break the login page itself.
  if (path === "/login" || path.startsWith("/auth/")) {
    return NextResponse.next();
  }

  // Fail loudly + safely if env vars are missing. Without these we can't
  // verify a session, so we redirect to /login (with a marker) instead of
  // throwing MIDDLEWARE_INVOCATION_FAILED for every request.
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!rawUrl || !anonKey) {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        {
          error:
            "Server misconfigured: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY missing on this deployment.",
        },
        { status: 500 },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "config");
    return NextResponse.redirect(url);
  }

  // Build a response we can write cookies to (Supabase will refresh tokens).
  const response = NextResponse.next({ request: req });
  const projectUrl = rawUrl.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");

  const supabase = createServerClient(
    projectUrl,
    anonKey,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const emailOk = user?.email?.toLowerCase().endsWith(ALLOWED_DOMAIN) ?? false;

  if (!user || !emailOk) {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: user ? "Forbidden (wrong domain)" : "Unauthorized" },
        { status: user ? 403 : 401 },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    if (user && !emailOk) url.searchParams.set("error", "wrong-domain");
    return NextResponse.redirect(url);
  }

  return response;
}

// Skip middleware for Next.js internals + static assets. Everything else
// (pages + API) goes through the auth gate.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
