import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { searchPlaces, type RawPlace } from "@/lib/places";
import { checkWebsitesParallel } from "@/lib/website-check";
import { enrichAll, extractHandle } from "@/lib/instagram";
import type { ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
// Vercel will reject 300s on Hobby (10s) and Pro (60s default). Local dev has
// no limit. Keeping this set so a future Pro Plus deploy could run scrapes
// in-process if we ever want that, but the default plan is local-only.
export const maxDuration = 300;

interface ScrapeBody {
  cities?: string[];
  terms?: string[];
  enrichInstagram?: boolean;
  skipExisting?: boolean;
}

/**
 * POST /api/scrape
 *
 * Streams Server-Sent Events as the pipeline progresses:
 *   data: { "stage": "searching", "city": "Varaždin", "term": "...", "message": "...", "counts": { ... } }
 *
 * Pipeline (step 6 — Places only, Instagram comes in step 8):
 *   1. For each (city × term): Google Places New Text Search, with pagination
 *      capped at 3 pages. Map each result; overwrite city with the input
 *      value (Google's parsed city is unreliable for accent-stripped names).
 *   2. Dedupe in-memory by place_id BEFORE the HEAD check phase — saves work
 *      and avoids ever counting a duplicate as a new lead.
 *   3. If skipExisting: query Supabase for existing place_ids and drop them.
 *   4. Drop rows without a phone.
 *   5. Parallel HEAD-check current_website (concurrency 10) to compute
 *      has_real_website per the spec's social-only / non-2xx / timeout rules.
 *   6. Upsert rows into `leads`. Only the scrape-derived columns are sent so
 *      user-edited fields (status, priority, notes, contacted_at,
 *      last_contact_method, instagram_*) are preserved on re-scrape.
 *   7. Emit a final 'done' event with summary counts.
 *
 * Errors during a single (city × term) emit an 'error' event but DON'T kill
 * the stream — we keep going so a transient quota hiccup doesn't waste the
 * rest of the run.
 */
export async function POST(req: NextRequest) {
  // Belt-and-suspenders: scraping isn't safe to run on Vercel (would exceed
  // any function timeout). Refuse early with a clear message. The /scrape
  // page also gets blocked by middleware in step 11.
  if (process.env.VERCEL === "1") {
    return new Response(
      JSON.stringify({ error: "Scraping is local-only in v1." }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GOOGLE_PLACES_API_KEY is not set in .env.local" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const body: ScrapeBody = await req.json().catch(() => ({}));
  const cities = Array.isArray(body.cities) ? body.cities : [];
  const terms = Array.isArray(body.terms) ? body.terms : [];
  const skipExisting = body.skipExisting !== false; // default ON

  if (cities.length === 0 || terms.length === 0) {
    return new Response(
      JSON.stringify({ error: "Provide at least one city and one term." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ScrapeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        // ---- 1. Search ----
        const allRaw: Array<RawPlace & { city: string }> = [];
        for (const city of cities) {
          for (const term of terms) {
            send({ stage: "searching", city, term, message: `Searching ${city}: ${term}…` });
            try {
              const places = await searchPlaces({ city, term, apiKey });
              for (const p of places) allRaw.push({ ...p, city });
              send({
                stage: "searching",
                city,
                term,
                message: `Found ${places.length} in ${city}: ${term}`,
                counts: { found: places.length },
              });
            } catch (err) {
              send({
                stage: "error",
                city,
                term,
                message: `Places error for ${city}/${term}: ${(err as Error).message}`,
              });
            }
          }
        }

        // ---- 2. Dedupe ----
        const seen = new Set<string>();
        const deduped: Array<RawPlace & { city: string }> = [];
        for (const p of allRaw) {
          if (seen.has(p.place_id)) continue;
          seen.add(p.place_id);
          deduped.push(p);
        }
        send({
          stage: "filtering",
          message: `Deduped ${allRaw.length} → ${deduped.length} unique`,
          counts: { found: deduped.length },
        });

        const supabase = getServerSupabase();

        // ---- 3. Skip existing ----
        let candidates = deduped;
        let skippedExisting = 0;
        if (skipExisting && deduped.length > 0) {
          const { data: existing, error: existingErr } = await supabase
            .from("leads")
            .select("place_id")
            .in("place_id", deduped.map((p) => p.place_id));
          if (existingErr) throw new Error(`Existing-check failed: ${existingErr.message}`);
          const existingSet = new Set((existing ?? []).map((r) => r.place_id as string));
          candidates = deduped.filter((p) => !existingSet.has(p.place_id));
          skippedExisting = deduped.length - candidates.length;
          send({
            stage: "filtering",
            message: `Skipped ${skippedExisting} already in DB`,
            counts: { skipped: skippedExisting },
          });
        }

        // ---- 4. Drop rows without a phone ----
        const beforePhone = candidates.length;
        candidates = candidates.filter((p) => p.phone && p.phone.trim().length > 0);
        send({
          stage: "filtering",
          message: `${candidates.length} of ${beforePhone} have a phone (dropped ${beforePhone - candidates.length})`,
        });

        // ---- 5. Website HEAD check ----
        if (candidates.length === 0) {
          send({
            stage: "done",
            message: "Nothing new to add.",
            counts: { found: deduped.length, qualified: 0, new: 0, skipped: skippedExisting },
          });
          controller.close();
          return;
        }

        send({
          stage: "filtering",
          message: `Checking ${candidates.length} websites (HEAD, 5s timeout, 10 in parallel)…`,
        });
        const websiteResults = await checkWebsitesParallel(
          candidates.map((p) => p.current_website),
          10,
        );

        // ---- 6. Build rows + upsert ----
        const rows = candidates.map((p, i) => ({
          place_id: p.place_id,
          name: p.name,
          phone: p.phone,
          current_website: p.current_website,
          address: p.address,
          city: p.city, // input city, not Google's parsed one
          latitude: p.latitude,
          longitude: p.longitude,
          google_rating: p.google_rating,
          google_review_count: p.google_review_count,
          has_real_website: websiteResults[i],
          qualified: !websiteResults[i] && !!p.phone,
        }));

        const qualifiedCount = rows.filter((r) => r.qualified).length;

        send({
          stage: "saving",
          message: `Upserting ${rows.length} leads (${qualifiedCount} qualified)…`,
        });

        const { error: upsertErr } = await supabase
          .from("leads")
          .upsert(rows, { onConflict: "place_id" });
        if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);

        // ---- 7. Optional Instagram enrichment ----
        if (body.enrichInstagram) {
          const apifyToken = process.env.APIFY_TOKEN;
          if (!apifyToken) {
            send({
              stage: "error",
              message: "APIFY_TOKEN not set; skipping Instagram enrichment.",
            });
          } else {
            // Re-fetch the just-upserted leads to know their post-upsert state
            // and to filter to the ones that NEED enrichment (instagram_followers
            // IS NULL). This is the idempotency guard: re-running with skip-
            // existing OFF won't re-charge Apify for already-enriched leads.
            const { data: candidates, error: candErr } = await supabase
              .from("leads")
              .select("place_id, current_website, instagram_handle")
              .in("place_id", rows.map((r) => r.place_id))
              .is("instagram_followers", null);

            if (candErr) {
              send({ stage: "error", message: `IG candidate query failed: ${candErr.message}` });
            } else {
              // Build place_id -> handle map. Prefer extracting from
              // current_website (the IG-as-website case); fall back to any
              // existing instagram_handle column (a previous run could have
              // set it without ever running enrichment, e.g. via manual SQL).
              const handlesByPlaceId = new Map<string, string>();
              for (const row of candidates ?? []) {
                const fromWebsite = extractHandle(row.current_website as string | null);
                const handle = fromWebsite ?? (row.instagram_handle as string | null);
                if (handle) handlesByPlaceId.set(row.place_id as string, handle.toLowerCase());
              }

              const uniqueHandles = Array.from(new Set(handlesByPlaceId.values()));

              if (uniqueHandles.length === 0) {
                send({
                  stage: "enriching",
                  message: "No leads with an Instagram handle to enrich.",
                });
              } else {
                send({
                  stage: "enriching",
                  message: `Enriching ${uniqueHandles.length} IG profiles in batches of 50…`,
                });

                try {
                  const enriched = await enrichAll(
                    uniqueHandles,
                    apifyToken,
                    (i, total, size) => {
                      send({
                        stage: "enriching",
                        message: `Apify batch ${i}/${total} (${size} handles)…`,
                      });
                    },
                  );

                  // Build per-place_id update rows. Skip place_ids whose handle
                  // didn't come back from Apify (private / deleted / blocked).
                  const igUpdates: Array<{
                    place_id: string;
                    instagram_handle: string;
                    instagram_followers: number | null;
                    instagram_bio: string | null;
                    instagram_last_post_at: string | null;
                    instagram_is_active: boolean | null;
                  }> = [];
                  for (const [placeId, handle] of handlesByPlaceId) {
                    const profile = enriched.get(handle);
                    if (!profile) continue;
                    igUpdates.push({
                      place_id: placeId,
                      instagram_handle: profile.handle,
                      instagram_followers: profile.followers,
                      instagram_bio: profile.bio,
                      instagram_last_post_at: profile.latestPostAt,
                      instagram_is_active: profile.isActive,
                    });
                  }

                  if (igUpdates.length > 0) {
                    send({
                      stage: "saving",
                      message: `Writing IG data for ${igUpdates.length} of ${uniqueHandles.length} handles…`,
                    });
                    // Per-row UPDATE (not upsert): these leads already exist by
                    // place_id, and a real upsert would try INSERT first and
                    // fail the `name NOT NULL` constraint since we don't send
                    // the name in the IG payload.
                    let updateFailures = 0;
                    for (const u of igUpdates) {
                      const { place_id, ...patch } = u;
                      const { error: igErr } = await supabase
                        .from("leads")
                        .update(patch)
                        .eq("place_id", place_id);
                      if (igErr) {
                        updateFailures++;
                        send({
                          stage: "error",
                          message: `IG update failed for ${place_id}: ${igErr.message}`,
                        });
                      }
                    }
                    if (updateFailures === 0) {
                      send({
                        stage: "enriching",
                        message: `IG enrichment complete: ${igUpdates.length} leads updated.`,
                      });
                    }
                  } else {
                    send({
                      stage: "enriching",
                      message: "Apify returned 0 matching profiles.",
                    });
                  }
                } catch (err) {
                  send({
                    stage: "error",
                    message: `Apify enrichment error: ${(err as Error).message}`,
                  });
                }
              }
            }
          }
        }

        send({
          stage: "done",
          message: `Done. ${rows.length} new/updated, ${qualifiedCount} qualified, ${skippedExisting} skipped.`,
          counts: {
            found: deduped.length,
            qualified: qualifiedCount,
            new: rows.length,
            skipped: skippedExisting,
          },
        });
      } catch (err) {
        send({ stage: "error", message: `Fatal: ${(err as Error).message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell any reverse proxies (nginx, Vercel edge) NOT to buffer — we want
      // events flushed to the client as they're emitted.
      "X-Accel-Buffering": "no",
    },
  });
}
