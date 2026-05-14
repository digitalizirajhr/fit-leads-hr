import { NextResponse } from "next/server";
import { getServerAuth } from "@/lib/supabase-auth-server";

const ALLOWED_DOMAIN = "@digitaliziraj.hr";

/**
 * Inline auth check for routes that the middleware skips (currently the
 * SSE-streaming /api/scrape* routes, where middleware's NextResponse.next()
 * wrapping breaks the stream pipe).
 *
 * Returns either:
 *   - { ok: true }  → caller proceeds with the request
 *   - { ok: false, response }  → caller MUST `return response` immediately
 */
export async function requireAuth(): Promise<
  { ok: true } | { ok: false; response: NextResponse }
> {
  try {
    const supabase = await getServerAuth();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      };
    }
    if (!user.email?.toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Forbidden (wrong domain)" },
          { status: 403 },
        ),
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Auth check failed: ${(err as Error).message}` },
        { status: 500 },
      ),
    };
  }
}
