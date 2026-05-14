import { ScrapeClient } from "@/components/scrape-client";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * /scrape — the form + live progress page.
 *
 * Server component fetches:
 *   - custom_terms from settings (for the term checkbox grid + inline manager)
 *   - distinct cities from leads (for the qualification rule's city restriction picker)
 *
 * The qualification rule itself is per-scrape and lives in client state —
 * not fetched here, not persisted.
 */
export default async function ScrapePage() {
  const supabase = getServerSupabase();
  const [settingsRes, citiesRes] = await Promise.all([
    supabase
      .from("settings")
      .select("custom_terms")
      .eq("id", "singleton")
      .maybeSingle(),
    supabase.from("leads").select("city").not("city", "is", null),
  ]);

  const customTerms = (settingsRes.data?.custom_terms as string[]) ?? [];
  const citiesInDb = Array.from(
    new Set(((citiesRes.data ?? []) as { city: string }[]).map((r) => r.city)),
  ).sort((a, b) => a.localeCompare(b, "hr"));

  return (
    <main className="mx-auto max-w-screen-lg space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Scrape</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulls fitness coaches from Google Places (New) for the selected cities and
          search terms. Filters down to those qualifying under the criteria you set
          below. Fires one request per (city × term) combo — keep this tab open.
        </p>
      </header>

      <ScrapeClient initialCustomTerms={customTerms} citiesInDb={citiesInDb} />
    </main>
  );
}
