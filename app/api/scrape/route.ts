import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { searchPlaces, type RawPlace } from "@/lib/places";
import { checkWebsitesParallel } from "@/lib/website-check";
import { computeQualified } from "@/lib/qualification";
import { requireAuth } from "@/lib/require-auth";
import { linkLeadsToRun } from "@/lib/scrape-runs";
import { DEFAULT_RULE, type QualificationRule, type ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
// 60s is the Hobby+Pro default. Each chunk = ONE (city, term), well under
// this in practice. The client orchestrates the loop across all combos.
export const maxDuration = 60;

interface Body {
  city?: string;
  term?: string;
  skipExisting?: boolean;
  /** Per-scrape qualification rule. If absent, falls back to DEFAULT_RULE. */
  rule?: Partial<QualificationRule>;
  /** If present, every upserted lead in this chunk is linked to this run id. */
  runId?: string;
}

/**
 * POST /api/scrape — one (city, term) chunk per request.
 *
 * Streams Server-Sent Events:
 *   - searching: starting / found N
 *   - filtering: dedupe / skip-existing / phone filter
 *   - saving: about to upsert
 *   - done: per-chunk summary with counts
 *   - error: anything that went wrong
 *
 * The client at /scrape loops through all selected (city × term) combos
 * sequentially, dispatching one POST per combo and aggregating counts.
 * IG enrichment happens via /api/scrape/enrich (different endpoint, also
 * polled by the client).
 */
export async function POST(req: NextRequest) {
  // Inline auth (middleware skips this route to avoid breaking SSE).
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GOOGLE_PLACES_API_KEY is not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const body: Body = await req.json().catch(() => ({}));
  const city = typeof body.city === "string" ? body.city.trim() : "";
  const term = typeof body.term === "string" ? body.term.trim() : "";
  const skipExisting = body.skipExisting !== false;
  // Merge with defaults so older clients (or partial bodies) still produce a
  // valid rule instead of crashing computeQualified on missing fields.
  const rule: QualificationRule = { ...DEFAULT_RULE, ...(body.rule ?? {}) };
  const runId = typeof body.runId === "string" ? body.runId : null;

  if (!city || !term) {
    return new Response(
      JSON.stringify({ error: "city and term are required" }),
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
        send({ stage: "searching", city, term, message: `Searching ${city}: ${term}…` });
        const places = await searchPlaces({ city, term, apiKey });
        send({
          stage: "searching",
          city,
          term,
          message: `Found ${places.length} in ${city}: ${term}`,
          counts: { found: places.length },
        });

        // ---- 2. Dedupe (within this chunk) ----
        const seen = new Set<string>();
        const deduped: RawPlace[] = [];
        for (const p of places) {
          if (seen.has(p.place_id)) continue;
          seen.add(p.place_id);
          deduped.push(p);
        }

        const supabase = getServerSupabase();

        // ---- 3. Skip existing place_ids in DB ----
        let candidates = deduped;
        let skippedExisting = 0;
        if (skipExisting && deduped.length > 0) {
          const { data: existing, error } = await supabase
            .from("leads")
            .select("place_id")
            .in("place_id", deduped.map((p) => p.place_id));
          if (error) throw new Error(`Existing-check failed: ${error.message}`);
          const existingSet = new Set((existing ?? []).map((r) => r.place_id as string));
          candidates = deduped.filter((p) => !existingSet.has(p.place_id));
          skippedExisting = deduped.length - candidates.length;
        }

        // ---- 4. Drop rows without a phone ----
        const beforePhone = candidates.length;
        candidates = candidates.filter((p) => p.phone && p.phone.trim().length > 0);
        send({
          stage: "filtering",
          city,
          term,
          message: `${candidates.length}/${beforePhone} have phone, ${skippedExisting} already in DB`,
        });

        if (candidates.length === 0) {
          send({
            stage: "done",
            city,
            term,
            message: `Nothing new in ${city}/${term}`,
            counts: { found: deduped.length, qualified: 0, new: 0, skipped: skippedExisting },
          });
          controller.close();
          return;
        }

        // ---- 5. Website HEAD check ----
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
          city, // input city, not Google's parsed one
          latitude: p.latitude,
          longitude: p.longitude,
          google_rating: p.google_rating,
          google_review_count: p.google_review_count,
          has_real_website: websiteResults[i],
          qualified: computeQualified(
            {
              has_real_website: websiteResults[i],
              phone: p.phone,
              google_rating: p.google_rating,
              google_review_count: p.google_review_count,
              // IG fields aren't enriched yet at scrape time — passed as nulls.
              // The IG-enrich endpoint will recompute via /api/settings/recompute-qualified
              // if you want enriched-aware qualification (or just hit the recompute
              // button manually after enrichment).
              instagram_handle: null,
              instagram_is_active: null,
              instagram_followers: null,
              city,
            },
            rule,
          ),
        }));

        const qualifiedCount = rows.filter((r) => r.qualified).length;

        send({
          stage: "saving",
          city,
          term,
          message: `Upserting ${rows.length} (${qualifiedCount} qualified)…`,
        });

        const { error: upsertErr } = await supabase
          .from("leads")
          .upsert(rows, { onConflict: "place_id" });
        if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);

        // Link these leads to the run for /history (best-effort).
        if (runId && rows.length > 0) {
          const { data: linked } = await supabase
            .from("leads")
            .select("id")
            .in("place_id", rows.map((r) => r.place_id));
          await linkLeadsToRun(runId, (linked ?? []).map((l) => l.id as string));
        }

        send({
          stage: "done",
          city,
          term,
          message: `Done ${city}/${term}: +${rows.length} (${qualifiedCount} qualified, ${skippedExisting} skipped)`,
          counts: {
            found: deduped.length,
            qualified: qualifiedCount,
            new: rows.length,
            skipped: skippedExisting,
          },
        });
      } catch (err) {
        send({
          stage: "error",
          city,
          term,
          message: `Error in ${city}/${term}: ${(err as Error).message}`,
        });
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
      "X-Accel-Buffering": "no",
    },
  });
}
