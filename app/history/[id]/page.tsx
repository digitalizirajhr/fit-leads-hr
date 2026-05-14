import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase-server";
import { Badge } from "@/components/ui/badge";
import { LeadsTable } from "@/components/leads-table";
import { StopRunButton } from "@/components/stop-run-button";
import { formatRelativeTime } from "@/lib/format";
import type { Lead, ScrapeRun } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * /history/[id] — detail of a past scrape run + the leads it produced.
 * Reuses LeadsTable so all the inline edits (status / priority / qualified
 * toggle) work the same as on the main /leads page.
 */
export default async function HistoryDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = getServerSupabase();

  const runRes = await supabase
    .from("scrape_runs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (runRes.error) {
    return (
      <main className="mx-auto max-w-screen-xl p-6">
        <p className="text-destructive">Error loading run: {runRes.error.message}</p>
      </main>
    );
  }
  if (!runRes.data) notFound();

  const run = runRes.data as ScrapeRun;

  // Fetch the linked leads via PostgREST's FK-join syntax. The previous
  // approach (SELECT lead_id FROM scrape_run_leads → SELECT * FROM leads
  // WHERE id IN (...)) put 765+ UUIDs in the URL, blowing past PostgREST's
  // ~16 KB URL cap and silently returning an error that we then swallowed,
  // showing "Leads from this run (0)" even when 765 link rows existed.
  //
  // The join encoding is `select=lead_id,leads(*)` — Supabase looks up the
  // FK relationship and joins server-side.
  const leadsRes = await supabase
    .from("scrape_run_leads")
    .select("lead_id, leads(*)")
    .eq("run_id", id)
    .limit(50000);

  let leadsError: string | null = null;
  const leads: Lead[] = [];
  if (leadsRes.error) {
    leadsError = leadsRes.error.message;
  } else {
    // PostgREST's nested-select returns the joined row as either an object
    // or an array depending on inferred cardinality, so we normalize via
    // `unknown` to avoid wrestling with the auto-generated type.
    const rawRows = (leadsRes.data ?? []) as Array<{ leads: unknown }>;
    for (const row of rawRows) {
      if (row.leads && typeof row.leads === "object" && !Array.isArray(row.leads)) {
        leads.push(row.leads as Lead);
      } else if (Array.isArray(row.leads)) {
        for (const l of row.leads) leads.push(l as Lead);
      }
    }
    // Order matches the /leads page: priority desc, then created_at desc.
    leads.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });
  }

  const storedCounts = run.counts ?? {};
  // Compute live qualified count from the actual joined leads — the
  // run.counts.qualified value is set at discovery-finalize time (before
  // enrichment runs), so it's almost always 0 for IG runs even after
  // enrichment marked dozens of leads as qualified.
  const liveQualified = leads.filter((l) => l.qualified).length;
  const c = {
    ...storedCounts,
    qualified: liveQualified,
  };

  return (
    <main className="mx-auto max-w-screen-2xl space-y-6 p-6">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-border pb-4">
        <Link
          href="/history"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          ← All runs
        </Link>
        <h1 className="text-xl font-semibold">{run.source} scrape</h1>
        <span
          className="text-xs text-muted-foreground"
          title={new Date(run.started_at).toLocaleString("hr")}
        >
          {formatRelativeTime(run.started_at)}
        </span>
        <Badge variant="secondary">
          {run.status === "done"
            ? "✓ done"
            : run.status === "error"
              ? "⚠️ error"
              : "… running"}
        </Badge>
        {run.status === "running" ? (
          <div className="ml-auto">
            <StopRunButton runId={run.id} />
          </div>
        ) : null}
      </header>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Found" value={c.found ?? 0} />
        <Stat label="Qualified" value={c.qualified ?? 0} />
        <Stat label="New" value={c.new ?? 0} />
        <Stat label="Skipped" value={c.skipped ?? 0} />
      </section>

      {run.error_message ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {run.error_message}
        </p>
      ) : run.status === "error" ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          This run was marked as errored but no specific message was captured.
          Most likely cause: a network blip or Apify rejected the input
          (e.g. private/non-existent username for a seed scrape, or quota
          exceeded). Re-run with the same params and watch the live SSE log
          on /scrape — it&apos;ll surface the real error in real time. Future
          runs will save the message to this page automatically.
        </p>
      ) : null}

      {leadsError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn&apos;t load linked leads: {leadsError}
        </p>
      ) : null}

      <details className="rounded-md border border-border p-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Params</summary>
        <pre className="mt-2 overflow-x-auto text-[11px] leading-tight">
          {JSON.stringify(run.params, null, 2)}
        </pre>
      </details>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Leads from this run ({leads.length})
        </h2>
        {leads.length === 0 ? (
          <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
            No leads linked to this run.
          </p>
        ) : (
          <LeadsTable leads={leads} />
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
