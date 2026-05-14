import { NextRequest, NextResponse } from "next/server";

const SAFE_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

/**
 * Reject browser-originated cross-site mutations. Auth is cookie-based, so
 * mutating endpoints need an origin/fetch-site check in addition to auth.
 */
export function rejectCrossSiteMutation(req: NextRequest): NextResponse | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return null;
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && !SAFE_FETCH_SITES.has(fetchSite)) {
    return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (!origin) return null;

  if (origin !== req.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  return null;
}

export function readStringArray(
  value: unknown,
  options: { maxItems: number; maxLength: number; field: string },
): { ok: true; value: string[] } | { ok: false; response: NextResponse } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `${options.field} must be an array of strings` },
        { status: 400 },
      ),
    };
  }
  if (value.length > options.maxItems) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `${options.field} cannot contain more than ${options.maxItems} items` },
        { status: 400 },
      ),
    };
  }

  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: `${options.field} must contain only strings` },
          { status: 400 },
        ),
      };
    }
    const trimmed = item.trim();
    if (trimmed.length > options.maxLength) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `${options.field} entries cannot exceed ${options.maxLength} characters`,
          },
          { status: 400 },
        ),
      };
    }
    if (trimmed) strings.push(trimmed);
  }

  return { ok: true, value: strings };
}
