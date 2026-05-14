import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

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

  // Best-effort count of what got linked before the stop.
  const { count: totalLinks } = await supabase
    .from("scrape_run_leads")
    .select("*", { count: "exact", head: true })
    .eq("run_id", id);
  const { count: qualifiedLinks } = await supabase
    .from("scrape_run_leads")
    .select("leads!inner(qualified)", { count: "exact", head: true })
    .eq("run_id", id)
    .eq("leads.qualified", true);

  const { error: updateErr } = await supabase
    .from("scrape_runs")
    .update({
      status: "error",
      ended_at: new Date().toISOString(),
      counts: {
        found: totalLinks ?? 0,
        qualified: qualifiedLinks ?? 0,
        new: totalLinks ?? 0,
        skipped: 0,
      },
      error_message: "Force-stopped by user",
    })
    .eq("id", id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
