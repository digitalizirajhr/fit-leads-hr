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
