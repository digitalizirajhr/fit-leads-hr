import { getServerSupabase } from "@/lib/supabase-server";
import type {
  ScrapeCounts,
  ScrapeRun,
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

/** Compute run counts from the rows actually linked to the run. */
export async function computeScrapeRunCounts(runId: string): Promise<ScrapeCounts> {
  const supabase = getServerSupabase();
  const { count: totalLinks, error: totalErr } = await supabase
    .from("scrape_run_leads")
    .select("*", { count: "exact", head: true })
    .eq("run_id", runId);
  if (totalErr) throw new Error(`computeScrapeRunCounts total: ${totalErr.message}`);

  const { count: qualifiedLinks, error: qualifiedErr } = await supabase
    .from("scrape_run_leads")
    .select("leads!inner(qualified)", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("leads.qualified", true);
  if (qualifiedErr) {
    throw new Error(`computeScrapeRunCounts qualified: ${qualifiedErr.message}`);
  }

  const linked = totalLinks ?? 0;
  return {
    found: linked,
    qualified: qualifiedLinks ?? 0,
    new: linked,
    skipped: 0,
  };
}

/** Attach live linked-lead counts to run rows without mutating the database. */
export async function withComputedRunCounts<T extends ScrapeRun>(
  runs: T[],
): Promise<T[]> {
  return Promise.all(
    runs.map(async (run) => ({
      ...run,
      counts: await computeScrapeRunCounts(run.id).catch(() => run.counts ?? {}),
    })),
  );
}

/**
 * Finalize a run with server-computed linked-lead counts. The client still
 * sends its local counters for backwards compatibility, but they are ignored.
 */
export async function finalizeScrapeRun(
  id: string,
  status: ScrapeRunStatus,
  _clientCounts: ScrapeCounts,
  errorMessage: string | null = null,
): Promise<void> {
  const supabase = getServerSupabase();
  const counts = await computeScrapeRunCounts(id);
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
    let counts: ScrapeCounts;
    try {
      counts = await computeScrapeRunCounts(r.id as string);
    } catch (err) {
      console.error(`janitor counts: ${(err as Error).message}`);
      counts = { found: 0, qualified: 0, new: 0, skipped: 0 };
    }

    await supabase
      .from("scrape_runs")
      .update({
        status: "error",
        ended_at: new Date().toISOString(),
        counts,
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
