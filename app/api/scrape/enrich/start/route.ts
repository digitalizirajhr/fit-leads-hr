import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { extractHandle, startEnrichmentRun } from "@/lib/instagram";
import { requireAuth } from "@/lib/require-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cap per Apify run. The actor handles 1000 profiles in one run comfortably
 * (~3–5 minutes total wall-clock). Bigger runs aren't proportionally faster
 * because the actor parallelizes internally, but they take longer to fully
 * finish, which adds latency to seeing the first results in /poll. The
 * orchestrator just calls /start again if more pending handles remain.
 */
const MAX_HANDLES_PER_RUN = 1000;

/**
 * POST /api/scrape/enrich/start — kicks off ONE Apify enrichment run for up
 * to MAX_HANDLES_PER_RUN pending handles, returns the run id immediately.
 *
 * The orchestrator client persists the runId + the requested handles list,
 * then polls /api/scrape/enrich/poll until done. When that finishes, if
 * more pending handles still exist, the orchestrator calls /start again
 * for the next batch.
 */
export async function POST() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) {
    return NextResponse.json({ error: "APIFY_TOKEN is not set" }, { status: 500 });
  }

  const supabase = getServerSupabase();

  // Pull the next batch of pending leads, oldest-first. Bypass Supabase's
  // default 1000-row cap so we see the real backlog.
  const { data: pending, error: pendErr } = await supabase
    .from("leads")
    .select("place_id, current_website, instagram_handle")
    .is("instagram_followers", null)
    .order("created_at", { ascending: true })
    .limit(50000);
  if (pendErr) {
    return NextResponse.json(
      { error: `Pending query: ${pendErr.message}` },
      { status: 500 },
    );
  }

  // Derive a deduped handle list, capped at MAX_HANDLES_PER_RUN. We stop
  // adding handles once we hit the cap rather than scanning the whole
  // backlog, since the orchestrator will call /start again for the rest.
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const row of pending ?? []) {
    if (handles.length >= MAX_HANDLES_PER_RUN) break;
    const fromWebsite = extractHandle(row.current_website as string | null);
    const handle = (fromWebsite ?? (row.instagram_handle as string | null))?.toLowerCase();
    if (handle && !seen.has(handle)) {
      handles.push(handle);
      seen.add(handle);
    }
  }

  // Compute the true total pending count for the orchestrator's progress
  // display. Separate `head + count: exact` query to dodge the row cap.
  const { count: truePendingCount } = await supabase
    .from("leads")
    .select("*", { count: "exact", head: true })
    .is("instagram_followers", null);

  if (handles.length === 0) {
    // Either nothing pending or nothing pending has a derivable handle.
    // Either way, the orchestrator's outer loop will see this and exit.
    return NextResponse.json({
      apifyRunId: null,
      requestedHandles: [],
      totalRequested: 0,
      totalPending: truePendingCount ?? 0,
    });
  }

  try {
    const { apifyRunId } = await startEnrichmentRun(handles, apifyToken);
    return NextResponse.json({
      apifyRunId,
      requestedHandles: handles,
      totalRequested: handles.length,
      totalPending: truePendingCount ?? handles.length,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
