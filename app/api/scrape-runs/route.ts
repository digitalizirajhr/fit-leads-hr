import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { createScrapeRun } from "@/lib/scrape-runs";
import type { ScrapeRun, ScrapeSourceType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_SOURCES: ScrapeSourceType[] = ["google", "instagram"];

/** GET /api/scrape-runs → reverse-chrono list of recent runs (cap 200). */
export async function GET() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("scrape_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json((data ?? []) as ScrapeRun[]);
}

/** POST /api/scrape-runs → create a new run. Body: { source, params } */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!VALID_SOURCES.includes(body.source)) {
    return NextResponse.json(
      { error: `source must be one of ${VALID_SOURCES.join(", ")}` },
      { status: 400 },
    );
  }
  const params =
    body.params && typeof body.params === "object"
      ? (body.params as Record<string, unknown>)
      : {};
  try {
    const id = await createScrapeRun(body.source as ScrapeSourceType, params);
    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
