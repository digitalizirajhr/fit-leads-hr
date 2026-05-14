import { ScrapeClient } from "@/components/scrape-client";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * /scrape — the form + live progress page.
 *
 * Server component fetches the user's saved custom terms so the form's
 * checkbox grid includes them on initial render (no client-side fetch
 * spinner). Custom terms are managed via the inline UI below the grid
 * AND from /settings; either path PATCHes /api/settings.
 */
export default async function ScrapePage() {
  const supabase = getServerSupabase();
  const { data } = await supabase
    .from("settings")
    .select("custom_terms")
    .eq("id", "singleton")
    .maybeSingle();
  const customTerms = (data?.custom_terms as string[]) ?? [];

  return (
    <main className="mx-auto max-w-screen-lg space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Scrape</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulls fitness coaches from Google Places (New) for the selected cities and
          search terms. Filters down to those qualifying under your current rule.
          Fires one request per (city × term) combo — keep this tab open.
        </p>
      </header>

      <ScrapeClient initialCustomTerms={customTerms} />
    </main>
  );
}
