import { NextRequest, NextResponse } from "next/server";
import {
  startDiscoveryRun,
  type DiscoveryMethod,
} from "@/lib/instagram-discovery";
import { requireAuth } from "@/lib/require-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_METHODS: DiscoveryMethod[] = ["hashtag", "location", "seed", "bio_keyword"];

interface Body {
  method?: DiscoveryMethod;
  values?: string[];
}

/**
 * POST /api/scrape/discover-ig/start — kicks off the Apify discovery run
 * asynchronously and returns the run id immediately.
 *
 * The client then polls /api/scrape/discover-ig/poll until the run finishes.
 * This split is here because some methods (notably seed-following for big
 * accounts like fitness_byiva @ 603 followings) take longer than Vercel's
 * 60s function limit when called via run-sync-get-dataset-items.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) {
    return NextResponse.json({ error: "APIFY_TOKEN is not set" }, { status: 500 });
  }

  const body: Body = await req.json().catch(() => ({}));
  const method = body.method;
  const values = Array.isArray(body.values)
    ? body.values.filter((v): v is string => typeof v === "string")
    : [];

  if (!method || !VALID_METHODS.includes(method)) {
    return NextResponse.json(
      { error: `method must be one of ${VALID_METHODS.join(", ")}` },
      { status: 400 },
    );
  }
  if (values.length === 0) {
    return NextResponse.json(
      { error: "values must be a non-empty string array" },
      { status: 400 },
    );
  }

  try {
    const { apifyRunId } = await startDiscoveryRun(method, values, apifyToken);
    return NextResponse.json({ apifyRunId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
