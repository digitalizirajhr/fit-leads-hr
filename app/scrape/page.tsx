import { ScrapeClient } from "@/components/scrape-client";

/**
 * /scrape — the form + live progress page.
 *
 * Server component that decides at render time whether to expose the form.
 * On Vercel (`process.env.VERCEL === "1"`) the scrape pipeline can't run
 * (Google Places + HEAD checks + Apify takes 5–15 min, way past Vercel's
 * function timeout), so we show a friendly "local-only" message instead.
 * Locally we delegate to <ScrapeClient/>, which owns the SSE state.
 */
export default function ScrapePage() {
  const onVercel = process.env.VERCEL === "1";

  return (
    <main className="mx-auto max-w-screen-lg space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Scrape</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulls fitness coaches from Google Places (New) for the selected cities and
          search terms. Filters down to those without a real website + with a phone.
        </p>
      </header>

      {onVercel ? <LocalOnlyMessage /> : <ScrapeClient />}
    </main>
  );
}

function LocalOnlyMessage() {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-6">
      <h2 className="text-base font-medium">Scraping runs locally only</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        A full Croatia sweep takes 5–15 minutes — well past Vercel&apos;s function
        timeout. So the deployed app is read/edit-only. To pull new leads, run
        the scraper on your laptop:
      </p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          Open Terminal:{" "}
          <code className="rounded bg-background px-1.5 py-0.5 text-xs">
            cd ~/Code/fit-leads-hr && npm run dev
          </code>
        </li>
        <li>
          Visit{" "}
          <code className="rounded bg-background px-1.5 py-0.5 text-xs">
            http://localhost:3000/scrape
          </code>
        </li>
        <li>
          Run the form there — leads sync to Supabase and appear here on the deployed
          /leads page automatically.
        </li>
      </ol>
    </div>
  );
}
