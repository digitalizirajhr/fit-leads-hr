import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { discoverHandles, type DiscoveryMethod } from "@/lib/instagram-discovery";
import { computeQualified } from "@/lib/qualification";
import { requireAuth } from "@/lib/require-auth";
import { linkLeadsToRun } from "@/lib/scrape-runs";
import { DEFAULT_RULE, type QualificationRule, type ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  method?: DiscoveryMethod;
  values?: string[];
  skipExisting?: boolean;
  rule?: Partial<QualificationRule>;
  /** If present, every upserted lead in this chunk is linked to this run id. */
  runId?: string;
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
  const runId = typeof body.runId === "string" ? body.runId : null;

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

        // ---- 3. Upsert RAW handles (no enrichment in this call) ----
        // Enrichment happens via the separate /api/scrape/enrich polling
        // endpoint after this returns — that pattern keeps each request
        // under Vercel's 60s function timeout. With 100+ candidates, doing
        // enrichment inline here would blow past the timeout (Apify takes
        // ~30-45s per 5 handles).
        const rows = toEnrich.map((handle) => ({
          place_id: `ig:${handle}`,
          name: handle, // Replaced with full name once enrichment fills bio/followers.
          phone: null,
          current_website: `https://instagram.com/${handle}`,
          address: null,
          city: null,
          latitude: null,
          longitude: null,
          google_rating: null,
          google_review_count: null,
          instagram_handle: handle,
          instagram_followers: null,
          instagram_bio: null,
          instagram_last_post_at: null,
          instagram_is_active: null,
          has_real_website: false,
          // Computed against current rule with placeholder data — will be
          // recomputed by the enrich endpoint once bio/followers land.
          qualified: computeQualified(
            {
              has_real_website: false,
              phone: null,
              google_rating: null,
              google_review_count: null,
              instagram_handle: handle,
              instagram_is_active: null,
              instagram_followers: null,
              city: null,
            },
            rule,
          ),
        }));

        const qualifiedCount = rows.filter((r) => r.qualified).length;
        send({
          stage: "saving",
          term,
          message: `Upserting ${rows.length} raw handles (${qualifiedCount} qualified pre-enrichment)…`,
        });

        const { error: upsertErr } = await supabase
          .from("leads")
          .upsert(rows, { onConflict: "place_id" });
        if (upsertErr) throw new Error(`Upsert: ${upsertErr.message}`);

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
          term,
          message: `Done ${method}: +${rows.length} raw rows. Enrichment + AI bio classification will run next (separate calls).`,
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
