import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { requireAuth } from "@/lib/require-auth";
import { computeScrapeRunCounts } from "@/lib/scrape-runs";
import { rejectCrossSiteMutation } from "@/lib/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/scrape-runs/:id/stop — force-mark a run as stopped.
 *
 * Sets status='error' with a "Stopped by user" message and counts pulled
 * from whatever leads got linked before the stop. The polling endpoints
 * (/api/scrape/discover-ig/poll, /api/scrape/enrich) check this status at
 * the top of each call and abort early if they see 'error', so even if the
 * orchestrating browser tab is still open the work will fizzle out within
 * one Apify poll cycle.
 */
export async function POST(_req: NextRequest, { params }: Ctx) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  const blocked = rejectCrossSiteMutation(_req);
  if (blocked) return blocked;

  const { id } = await params;
  const supabase = getServerSupabase();

  // Confirm the run exists and is currently running. Trying to stop a
  // 'done' or already-'error' run is a no-op (return 204).
  const { data: existing, error: fetchErr } = await supabase
    .from("scrape_runs")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (existing.status !== "running") {
    return new NextResponse(null, { status: 204 });
  }

  let counts;
  try {
    counts = await computeScrapeRunCounts(id);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const { error: updateErr } = await supabase
    .from("scrape_runs")
    .update({
      status: "error",
      ended_at: new Date().toISOString(),
      counts,
      error_message: "Force-stopped by user",
    })
    .eq("id", id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
