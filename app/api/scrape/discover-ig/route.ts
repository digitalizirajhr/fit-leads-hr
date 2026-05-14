import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { enrichAll } from "@/lib/instagram";
import { discoverHandles, type DiscoveryMethod } from "@/lib/instagram-discovery";
import { filterCoaches } from "@/lib/coach-classifier";
import { computeQualified } from "@/lib/qualification";
import { requireAuth } from "@/lib/require-auth";
import { DEFAULT_RULE, type QualificationRule, type ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  method?: DiscoveryMethod;
  values?: string[];
  skipExisting?: boolean;
  rule?: Partial<QualificationRule>;
}

const VALID_METHODS: DiscoveryMethod[] = ["hashtag", "location", "seed", "bio_keyword"];

/**
 * POST /api/scrape/discover-ig — one (method × values) chunk per request.
 *
 * Streams Server-Sent Events through the IG discovery pipeline:
 *   1. discover via the chosen Apify actor → list of handles
 *   2. dedupe + skip-existing
 *   3. enrich via existing instagram-profile-scraper
 *   4. filter for fitness coaches (keyword first, AI fallback for misses if
 *      ANTHROPIC_API_KEY is set)
 *   5. upsert into `leads` with synthetic place_id "ig:HANDLE"
 *
 * Inline auth (middleware skips /api/scrape* to avoid breaking SSE — same
 * pattern as the Google /api/scrape).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) {
    return new Response(
      JSON.stringify({ error: "APIFY_TOKEN is not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const body: Body = await req.json().catch(() => ({}));
  const method = body.method;
  const values = Array.isArray(body.values)
    ? body.values.filter((v): v is string => typeof v === "string")
    : [];
  const skipExisting = body.skipExisting !== false;
  const rule: QualificationRule = { ...DEFAULT_RULE, ...(body.rule ?? {}) };

  if (!method || !VALID_METHODS.includes(method)) {
    return new Response(
      JSON.stringify({ error: `method must be one of ${VALID_METHODS.join(", ")}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (values.length === 0) {
    return new Response(
      JSON.stringify({ error: "values must be a non-empty string array" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ScrapeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      // Keep the SSE event "term" field short so the UI log doesn't get noisy.
      const term = `${method}:${values.join(",").slice(0, 60)}`;

      try {
        // ---- 1. Discover handles ----
        send({
          stage: "searching",
          term,
          message: `Discovering via ${method}: ${values.join(", ")}…`,
        });
        const candidates = await discoverHandles(method, values, apifyToken);
        send({
          stage: "searching",
          term,
          message: `Found ${candidates.length} candidate handles`,
          counts: { found: candidates.length },
        });

        if (candidates.length === 0) {
          send({
            stage: "done",
            term,
            message: `No candidates from ${method}.`,
            counts: { found: 0, qualified: 0, new: 0, skipped: 0 },
          });
          controller.close();
          return;
        }

        const supabase = getServerSupabase();

        // ---- 2. Skip-existing (by IG handle OR synthetic ig: place_id) ----
        let toEnrich = candidates;
        let skippedExisting = 0;
        if (skipExisting) {
          // Use two simpler queries OR'd in JS instead of a complex .or() string,
          // because PostgREST .or() with quoted lists is fragile when handles
          // contain dots (which they often do — e.g. "vilim.puclin").
          const placeIds = candidates.map((h) => `ig:${h}`);
          const [byPlaceId, byHandle] = await Promise.all([
            supabase.from("leads").select("place_id").in("place_id", placeIds),
            supabase.from("leads").select("instagram_handle").in("instagram_handle", candidates),
          ]);
          if (byPlaceId.error) throw new Error(`Existing-check (place_id): ${byPlaceId.error.message}`);
          if (byHandle.error) throw new Error(`Existing-check (handle): ${byHandle.error.message}`);

          const existingSet = new Set<string>();
          for (const r of byPlaceId.data ?? []) {
            const pid = r.place_id as string;
            if (pid.startsWith("ig:")) existingSet.add(pid.slice(3).toLowerCase());
          }
          for (const r of byHandle.data ?? []) {
            if (r.instagram_handle) existingSet.add((r.instagram_handle as string).toLowerCase());
          }
          toEnrich = candidates.filter((h) => !existingSet.has(h));
          skippedExisting = candidates.length - toEnrich.length;
          send({
            stage: "filtering",
            term,
            message: `Skipped ${skippedExisting} already in DB; enriching ${toEnrich.length}`,
            counts: { skipped: skippedExisting },
          });
        }

        if (toEnrich.length === 0) {
          send({
            stage: "done",
            term,
            message: `Nothing new (${skippedExisting} already in DB).`,
            counts: { found: candidates.length, qualified: 0, new: 0, skipped: skippedExisting },
          });
          controller.close();
          return;
        }

        // ---- 3. Enrich via existing instagram-profile-scraper ----
        send({ stage: "enriching", term, message: `Enriching ${toEnrich.length} profiles…` });
        const enrichedMap = await enrichAll(toEnrich, apifyToken);
        const enriched = Array.from(enrichedMap.values());
        send({
          stage: "enriching",
          term,
          message: `Got ${enriched.length} profiles back`,
          counts: { found: enriched.length },
        });

        // ---- 4. Coach filter (keyword + AI fallback) ----
        send({ stage: "filtering", term, message: `Filtering for fitness coaches…` });
        const coaches = await filterCoaches(enriched, {
          onAiCall: (n) =>
            send({
              stage: "filtering",
              term,
              message: `${n} bios sent to Claude Haiku for fallback classification`,
            }),
          onAiError: (n) =>
            send({
              stage: "filtering",
              term,
              message: `${n} AI calls failed (no credits / network) — kept those profiles for manual review`,
            }),
        });
        send({
          stage: "filtering",
          term,
          message: `${coaches.length} of ${enriched.length} look like coaches`,
        });

        if (coaches.length === 0) {
          send({
            stage: "done",
            term,
            message: `No coaches kept after filter.`,
            counts: { found: candidates.length, qualified: 0, new: 0, skipped: skippedExisting },
          });
          controller.close();
          return;
        }

        // ---- 5. Build rows + upsert ----
        const rows = coaches.map((p) => ({
          place_id: `ig:${p.handle}`,
          name: p.handle, // No fullName field on EnrichedProfile; handle is unique enough
          phone: null,
          current_website: `https://instagram.com/${p.handle}`,
          address: null,
          city: null,
          latitude: null,
          longitude: null,
          google_rating: null,
          google_review_count: null,
          instagram_handle: p.handle,
          instagram_followers: p.followers,
          instagram_bio: p.bio,
          instagram_last_post_at: p.latestPostAt,
          instagram_is_active: p.isActive,
          has_real_website: false,
          qualified: computeQualified(
            {
              has_real_website: false,
              phone: null,
              google_rating: null,
              google_review_count: null,
              instagram_handle: p.handle,
              instagram_is_active: p.isActive,
              instagram_followers: p.followers,
              city: null,
            },
            rule,
          ),
        }));

        const qualifiedCount = rows.filter((r) => r.qualified).length;
        send({
          stage: "saving",
          term,
          message: `Upserting ${rows.length} (${qualifiedCount} qualified)…`,
        });

        const { error: upsertErr } = await supabase
          .from("leads")
          .upsert(rows, { onConflict: "place_id" });
        if (upsertErr) throw new Error(`Upsert: ${upsertErr.message}`);

        send({
          stage: "done",
          term,
          message: `Done ${method}: +${rows.length} (${qualifiedCount} qualified, ${skippedExisting} skipped)`,
          counts: {
            found: candidates.length,
            qualified: qualifiedCount,
            new: rows.length,
            skipped: skippedExisting,
          },
        });
      } catch (err) {
        send({ stage: "error", term, message: `Error: ${(err as Error).message}` });
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
