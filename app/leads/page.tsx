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
    hasPhone?: string;
    hasIg?: string;
    activeIg?: string;
    minRating?: string;
    minReviews?: string;
    minFollowers?: string;
    page?: string;
    pageSize?: string;
  }>;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
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
  const page = boundedInt(params.page, 1, 1, 10000);
  const pageSize = boundedInt(params.pageSize, 100, 25, 200);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Build the filtered query
  let q = supabase.from("leads").select("*", { count: "exact" });

  if (params.city) q = q.eq("city", params.city);
  if (params.status) q = q.eq("status", params.status as LeadStatus);
  if (params.qualified !== "false") q = q.eq("qualified", true);
  if (params.noWebsite === "true") q = q.eq("has_real_website", false);
  if (params.search) q = q.ilike("name", `%${params.search}%`);

  // Per-criterion filters mirror the qualification rule (lib/qualification.ts).
  // All AND together. Empty/missing param = no filter for that criterion.
  if (params.hasPhone === "true") {
    q = q.not("phone", "is", null).neq("phone", "");
  }
  if (params.hasIg === "true") q = q.not("instagram_handle", "is", null);
  if (params.activeIg === "true") q = q.eq("instagram_is_active", true);

  const minRatingNum = parseFloat(params.minRating ?? "");
  if (Number.isFinite(minRatingNum)) q = q.gte("google_rating", minRatingNum);

  const minReviewsNum = parseInt(params.minReviews ?? "", 10);
  if (Number.isFinite(minReviewsNum)) q = q.gte("google_review_count", minReviewsNum);

  const minFollowersNum = parseInt(params.minFollowers ?? "", 10);
  if (Number.isFinite(minFollowersNum)) q = q.gte("instagram_followers", minFollowersNum);

  q = q
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, to);

  const [
    { data: leadsData, error: leadsError, count: filteredCount },
    totalRes,
    citiesRes,
  ] = await Promise.all([
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
  const matchingCount = filteredCount ?? 0;
  const totalCount = totalRes.count ?? 0;

  // Distinct cities, sorted Croatian-locale.
  const cities = Array.from(
    new Set(((citiesRes.data ?? []) as { city: string }[]).map((r) => r.city)),
  ).sort((a, b) => a.localeCompare(b, "hr"));

  const totalPages = Math.max(1, Math.ceil(matchingCount / pageSize));
  const pageHref = (targetPage: number) => {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) sp.set(key, value);
    }
    if (targetPage <= 1) sp.delete("page");
    else sp.set("page", String(targetPage));
    if (pageSize === 100) sp.delete("pageSize");
    else sp.set("pageSize", String(pageSize));
    const qs = sp.toString();
    return qs ? `/leads?${qs}` : "/leads";
  };

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
      <LeadsFilters cities={cities} shownCount={matchingCount} totalCount={totalCount} />
      <LeadsTable leads={leads} />
      {matchingCount > pageSize ? (
        <nav className="flex items-center justify-between border-t border-border pt-4 text-sm">
          <Link
            href={pageHref(Math.max(1, page - 1))}
            aria-disabled={page <= 1}
            className={
              page <= 1
                ? "pointer-events-none text-muted-foreground/50"
                : "text-muted-foreground underline-offset-4 hover:underline"
            }
          >
            Previous
          </Link>
          <span className="text-xs text-muted-foreground">
            Page {Math.min(page, totalPages)} of {totalPages}
          </span>
          <Link
            href={pageHref(Math.min(totalPages, page + 1))}
            aria-disabled={page >= totalPages}
            className={
              page >= totalPages
                ? "pointer-events-none text-muted-foreground/50"
                : "text-muted-foreground underline-offset-4 hover:underline"
            }
          >
            Next
          </Link>
        </nav>
      ) : null}
    </main>
  );
}
