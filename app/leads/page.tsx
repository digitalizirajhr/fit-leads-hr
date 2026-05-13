import Link from "next/link";
import { getServerSupabase } from "@/lib/supabase-server";
import { LeadsFilters } from "@/components/leads-filters";
import { LeadsTable } from "@/components/leads-table";
import type { Lead, LeadStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{
    city?: string;
    status?: string;
    qualified?: string;
    noWebsite?: string;
    search?: string;
  }>;
}

/**
 * Server component. Reads filter state from the URL, fetches the matching
 * leads + the total row count + the distinct cities (for the filter dropdown)
 * in parallel, then hands off to the client table.
 *
 * Why a server component? Two reasons:
 *  1. Initial render is data-rich and we want it on the wire as HTML — no
 *     loading spinner on first paint.
 *  2. We need the SUPABASE_SERVICE_KEY to bypass RLS, which can only safely
 *     live on the server.
 *
 * Filter changes update the URL (handled by <LeadsFilters/>), which
 * re-runs this component server-side and returns a fresh table.
 */
export default async function LeadsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const supabase = getServerSupabase();

  // Build the filtered query
  let q = supabase.from("leads").select("*");

  if (params.city) q = q.eq("city", params.city);
  if (params.status) q = q.eq("status", params.status as LeadStatus);
  if (params.qualified !== "false") q = q.eq("qualified", true);
  if (params.noWebsite === "true") q = q.eq("has_real_website", false);
  if (params.search) q = q.ilike("name", `%${params.search}%`);

  q = q.order("priority", { ascending: false }).order("created_at", { ascending: false });

  const [{ data: leadsData, error: leadsError }, totalRes, citiesRes] = await Promise.all([
    q,
    supabase.from("leads").select("id", { count: "exact", head: true }),
    supabase.from("leads").select("city").not("city", "is", null),
  ]);

  if (leadsError) {
    return (
      <main className="mx-auto max-w-screen-2xl p-6">
        <h1 className="text-xl font-semibold">Leads</h1>
        <p className="mt-4 text-destructive">Error loading leads: {leadsError.message}</p>
      </main>
    );
  }

  const leads = (leadsData ?? []) as Lead[];
  const totalCount = totalRes.count ?? 0;

  // Distinct cities, sorted Croatian-locale.
  const cities = Array.from(
    new Set(((citiesRes.data ?? []) as { city: string }[]).map((r) => r.city)),
  ).sort((a, b) => a.localeCompare(b, "hr"));

  // First-run empty state: zero rows total and no filters applied.
  if (totalCount === 0) {
    return (
      <main className="mx-auto max-w-screen-2xl p-6">
        <h1 className="text-xl font-semibold">Leads</h1>
        <div className="mt-16 flex flex-col items-center gap-3 text-center text-muted-foreground">
          <p>No leads yet. Run a scrape to get started.</p>
          <Link href="/scrape" className="text-sm underline underline-offset-4">
            Go to /scrape →
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-screen-2xl space-y-4 p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Leads</h1>
        <Link
          href="/scrape"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Run scrape →
        </Link>
      </div>
      <LeadsFilters cities={cities} shownCount={leads.length} totalCount={totalCount} />
      <LeadsTable leads={leads} />
    </main>
  );
}
