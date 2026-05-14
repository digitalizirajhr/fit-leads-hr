import Link from "next/link";
import { getServerSupabase } from "@/lib/supabase-server";
import { withComputedRunCounts } from "@/lib/scrape-runs";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRelativeTime } from "@/lib/format";
import type { ScrapeRun } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Compact one-line summary of a run's params, shown in the history table.
 * For Google: "N cities × M terms".  For Instagram: "method (N), method (M)".
 */
function summariseParams(run: ScrapeRun): string {
  const p = run.params as Record<string, unknown>;
  if (run.source === "google") {
    const cities = Array.isArray(p.cities) ? (p.cities as string[]) : [];
    const terms = Array.isArray(p.terms) ? (p.terms as string[]) : [];
    return `${cities.length} cit${cities.length === 1 ? "y" : "ies"} × ${terms.length} term${terms.length === 1 ? "" : "s"}`;
  }
  if (run.source === "instagram") {
    const methods = Array.isArray(p.methods)
      ? (p.methods as Array<{ method: string; values: string[] }>)
      : [];
    if (methods.length === 0) return "—";
    return methods.map((m) => `${m.method} (${m.values.length})`).join(", ");
  }
  return "—";
}

export default async function HistoryPage() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("scrape_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(200);

  if (error) {
    return (
      <main className="mx-auto max-w-screen-2xl p-6">
        <p className="text-destructive">Error loading history: {error.message}</p>
      </main>
    );
  }

  const runs = await withComputedRunCounts((data ?? []) as ScrapeRun[]);

  return (
    <main className="mx-auto max-w-screen-2xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Scrape history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Past runs with their params and outcomes. Click a row to see the leads it produced.
        </p>
      </header>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
          <p>No scrape runs yet.</p>
          <Link href="/scrape" className="text-sm underline underline-offset-4">
            Go to /scrape →
          </Link>
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Params</TableHead>
                <TableHead className="text-right">Found</TableHead>
                <TableHead className="text-right">Qualified</TableHead>
                <TableHead className="text-right">New</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const c = run.counts ?? {};
                return (
                  <TableRow key={run.id}>
                    <TableCell
                      title={new Date(run.started_at).toLocaleString("hr")}
                      className="text-xs text-muted-foreground"
                    >
                      {formatRelativeTime(run.started_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{run.source}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{summariseParams(run)}</TableCell>
                    <TableCell className="text-right">{c.found ?? 0}</TableCell>
                    <TableCell className="text-right">{c.qualified ?? 0}</TableCell>
                    <TableCell className="text-right">{c.new ?? 0}</TableCell>
                    <TableCell className="text-right">{c.skipped ?? 0}</TableCell>
                    <TableCell>
                      {run.status === "done" ? (
                        <span className="text-green-300">✓ done</span>
                      ) : run.status === "error" ? (
                        <span
                          className="text-destructive"
                          title={run.error_message ?? ""}
                        >
                          ⚠️ error
                        </span>
                      ) : (
                        <span className="text-muted-foreground">… running</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/history/${run.id}`}
                        className="text-xs underline-offset-4 hover:underline"
                      >
                        View
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
