import { ScrapeClient } from "@/components/scrape-client";

/**
 * /scrape — the form + live progress page.
 *
 * The scrape pipeline is chunked: the client loops through every selected
 * (city × term) combo, dispatching one POST per combo. Each request is well
 * under Vercel's function timeout, so the page works the same on the
 * deployed app as it does locally — just slower wall-clock as the loop
 * iterates.
 */
export default function ScrapePage() {
  return (
    <main className="mx-auto max-w-screen-lg space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Scrape</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulls fitness coaches from Google Places (New) for the selected cities and
          search terms. Filters down to those without a real website + with a phone.
          Fires one request per (city × term) combo — the full Croatia sweep takes
          5–15 minutes; keep this tab open.
        </p>
      </header>

      <ScrapeClient />
    </main>
  );
}
