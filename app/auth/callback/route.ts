import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerAuth } from "@/lib/supabase-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DOMAIN = "@digitaliziraj.hr";

/**
 * GET /auth/callback?code=…
 *
 * Google OAuth redirects here after the user picks an account. We exchange
 * the code for a Supabase session, then enforce the domain restriction:
 *   - email ends with @digitaliziraj.hr → land on /leads
 *   - else → delete the just-created user via admin API, sign out, redirect
 *     back to /login with an error banner.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=no-code", req.url));
  }

  const supabase = await getServerAuth();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data?.user) {
    return NextResponse.redirect(new URL("/login?error=exchange", req.url));
  }

  const email = data.user.email ?? "";
  if (!email.toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    // Reject: clean up the just-created auth user so they don't accumulate.
    // Admin client uses the service-role key (separate from the cookie-bound
    // session client) to call the admin API.
    const projectUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
      .replace(/\/+$/, "")
      .replace(/\/rest\/v1$/, "");
    const admin = createClient(projectUrl, process.env.SUPABASE_SERVICE_KEY ?? "", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    try {
      await admin.auth.admin.deleteUser(data.user.id);
    } catch {
      // Best-effort cleanup; don't block the sign-out path on failure here.
    }

    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=wrong-domain", req.url));
  }

  return NextResponse.redirect(new URL("/leads", req.url));
}
