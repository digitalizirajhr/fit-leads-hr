import { NextResponse, type NextRequest } from "next/server";
import { getServerAuth } from "@/lib/supabase-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /auth/signout
 *
 * Clears the Supabase session cookie and redirects to /login. POST (not GET)
 * so a stray prefetch / link visit can't accidentally sign the user out.
 * Triggered by the small <form> in the layout's nav.
 */
export async function POST(req: NextRequest) {
  const supabase = await getServerAuth();
  await supabase.auth.signOut();
  // 303 See Other → browser switches POST to GET for the redirect target.
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
