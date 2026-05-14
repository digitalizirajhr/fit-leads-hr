import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase-server";
import { Badge } from "@/components/ui/badge";
import { LeadsTable } from "@/components/leads-table";
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

  const [runRes, linksRes] = await Promise.all([
    supabase.from("scrape_runs").select("*").eq("id", id).maybeSingle(),
    supabase.from("scrape_run_leads").select("lead_id").eq("run_id", id),
  ]);

  if (runRes.error) {
    return (
      <main className="mx-auto max-w-screen-xl p-6">
        <p className="text-destructive">Error loading run: {runRes.error.message}</p>
      </main>
    );
  }
  if (!runRes.data) notFound();

  const run = runRes.data as ScrapeRun;
  const leadIds = ((linksRes.data ?? []) as Array<{ lead_id: string }>).map(
    (l) => l.lead_id,
  );

  let leads: Lead[] = [];
  if (leadIds.length > 0) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .in("id", leadIds)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });
    if (!error) leads = (data ?? []) as Lead[];
  }

  const c = run.counts ?? {};

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
