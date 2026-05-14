import { getServerSupabase } from "@/lib/supabase-server";
import type {
  ScrapeCounts,
  ScrapeRunStatus,
  ScrapeSourceType,
} from "@/lib/types";

/**
 * Insert a new `scrape_runs` row, return its id. Called by the client at the
 * very start of each scrape so chunk endpoints can link their leads to it.
 */
export async function createScrapeRun(
  source: ScrapeSourceType,
  params: Record<string, unknown>,
): Promise<string> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("scrape_runs")
    .insert({ source, params })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`createScrapeRun: ${error.message}`);
  if (!data?.id) throw new Error("createScrapeRun: no id returned");
  return data.id as string;
}

/**
 * Finalize a run with status + final counts. Called once by the client after
 * all chunks complete (or when the orchestrator aborts on error).
 */
export async function finalizeScrapeRun(
  id: string,
  status: ScrapeRunStatus,
  counts: ScrapeCounts,
  errorMessage: string | null = null,
): Promise<void> {
  const supabase = getServerSupabase();
  const { error } = await supabase
    .from("scrape_runs")
    .update({
      ended_at: new Date().toISOString(),
      status,
      counts,
      error_message: errorMessage,
    })
    .eq("id", id);
  if (error) throw new Error(`finalizeScrapeRun: ${error.message}`);
}

/**
 * Mark any run still `running` for longer than `staleMinutes` as `error` with
 * a marker message. Catches the "user closed their browser tab mid-scrape"
 * case where finalize never got called.
 *
 * Best-effort: errors are swallowed (logged) so a janitor hiccup doesn't
 * fail the page render that triggered it.
 *
 * The qualified/new counts are populated from the rows actually linked to
 * each run so even an abandoned run shows useful numbers.
 */
export async function janitorFinalizeStaleRuns(staleMinutes = 10): Promise<void> {
  const supabase = getServerSupabase();
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();

  const { data: stale, error } = await supabase
    .from("scrape_runs")
    .select("id")
    .eq("status", "running")
    .lt("started_at", cutoff);
  if (error) {
    console.error(`janitor: ${error.message}`);
    return;
  }
  if (!stale || stale.length === 0) return;

  for (const r of stale) {
    const { count: totalLinks } = await supabase
      .from("scrape_run_leads")
      .select("*", { count: "exact", head: true })
      .eq("run_id", r.id as string);
    const { count: qualifiedLinks } = await supabase
      .from("scrape_run_leads")
      .select("leads!inner(qualified)", { count: "exact", head: true })
      .eq("run_id", r.id as string)
      .eq("leads.qualified", true);

    await supabase
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
        error_message: `Auto-finalized by janitor (orchestration tab closed before finalize)`,
      })
      .eq("id", r.id as string);
  }
}

/**
 * Link upserted leads to a run. Best-effort — we log on failure but don't
 * throw so a hiccup linking doesn't fail an otherwise-successful chunk.
 * `ignoreDuplicates` makes re-runs idempotent.
 */
export async function linkLeadsToRun(
  runId: string,
  leadIds: string[],
): Promise<void> {
  if (leadIds.length === 0) return;
  const supabase = getServerSupabase();
  const rows = leadIds.map((lid) => ({ run_id: runId, lead_id: lid }));
  const { error } = await supabase
    .from("scrape_run_leads")
    .upsert(rows, { onConflict: "run_id,lead_id", ignoreDuplicates: true });
  if (error) {
    console.error(`linkLeadsToRun: ${error.message}`);
  }
}
