import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { extractHandle, enrichAll } from "@/lib/instagram";
import { filterCoaches } from "@/lib/coach-classifier";
import { requireAuth } from "@/lib/require-auth";
import type { ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  /** How many leads to enrich per request. Apify timing scales roughly linearly
   *  per profile, so we keep batches small to fit the 60s function timeout. */
  batchSize?: number;
}

const DEFAULT_BATCH = 3;
const MIN_BATCH = 1;
const MAX_BATCH = 10;

/**
 * POST /api/scrape/enrich — process the next batch of pending IG enrichments.
 *
 * Idempotent. Picks the next N leads where instagram_followers IS NULL and
 * a handle can be derived (from current_website matching the IG regex, or
 * from an existing instagram_handle column). Runs Apify on the batch,
 * UPDATES (not upsert — these rows already exist) per place_id.
 *
 * The terminal `done` event includes counts.processed (this batch) and
 * counts.remaining (how many candidates still pending after this batch).
 * The client polls this endpoint until remaining = 0.
 */
export async function POST(req: NextRequest) {
  // Inline auth (middleware skips this route to avoid breaking SSE).
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
  const batchSize = clamp(
    typeof body.batchSize === "number" ? body.batchSize : DEFAULT_BATCH,
    MIN_BATCH,
    MAX_BATCH,
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ScrapeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const supabase = getServerSupabase();

        // Find ALL leads needing enrichment so we can report `remaining`.
        const { data: pending, error: pendErr } = await supabase
          .from("leads")
          .select("place_id, current_website, instagram_handle")
          .is("instagram_followers", null);
        if (pendErr) throw new Error(`Pending query: ${pendErr.message}`);

        // Build place_id -> handle for those with a derivable handle.
        const handlesByPlaceId = new Map<string, string>();
        for (const row of pending ?? []) {
          const fromWebsite = extractHandle(row.current_website as string | null);
          const handle = fromWebsite ?? (row.instagram_handle as string | null);
          if (handle) handlesByPlaceId.set(row.place_id as string, handle.toLowerCase());
        }

        const totalPending = handlesByPlaceId.size;

        if (totalPending === 0) {
          send({
            stage: "done",
            message: "No leads need IG enrichment.",
            counts: { processed: 0, remaining: 0 },
          });
          controller.close();
          return;
        }

        // Take next batch (Map preserves insertion order).
        const placeIds = Array.from(handlesByPlaceId.keys()).slice(0, batchSize);
        const handles = placeIds.map((pid) => handlesByPlaceId.get(pid)!);

        send({
          stage: "enriching",
          message: `Enriching ${placeIds.length} of ${totalPending} pending IG profiles…`,
        });

        const enriched = await enrichAll(handles, apifyToken);

        // Run AI/keyword coach classifier on the enriched profiles. Output
        // is the SUBSET considered coaches; we use it to set `qualified` for
        // each row (true if coach, false otherwise) — but only when the row
        // doesn't have a manual override. This way the existing manual
        // override semantics are preserved.
        const profilesArr = Array.from(enriched.values());
        const coaches = await filterCoaches(profilesArr, {
          onAiCall: (n) =>
            send({
              stage: "filtering",
              message: `${n} bios sent to Claude Haiku for coach classification`,
            }),
          onAiError: (n) =>
            send({
              stage: "filtering",
              message: `${n} AI calls failed (no credits / network) — those profiles kept as not-qualified`,
            }),
        });
        const coachHandles = new Set(coaches.map((c) => c.handle.toLowerCase()));

        // Fetch existing override flags so we don't clobber manual choices.
        const { data: overrideRows } = await supabase
          .from("leads")
          .select("place_id, qualified_override")
          .in("place_id", placeIds);
        const overrideMap = new Map(
          (overrideRows ?? []).map((r) => [
            r.place_id as string,
            r.qualified_override as boolean | null,
          ]),
        );

        // Per-place_id UPDATE. ALWAYS write a row even when Apify returned
        // no profile for the handle (private/deleted accounts) or returned
        // null follower count — otherwise instagram_followers stays NULL
        // and the next /api/scrape/enrich call picks the same lead up
        // again, looping forever.
        //
        // We use `0` as the "tried but no useful data" sentinel for
        // instagram_followers. Real accounts with 0 followers exist but
        // are vanishingly rare for our purposes.
        let processed = 0;
        let unreachable = 0;
        for (const placeId of placeIds) {
          const handle = handlesByPlaceId.get(placeId)!;
          const profile = enriched.get(handle);
          const isCoach = profile ? coachHandles.has(handle) : false;
          const override = overrideMap.get(placeId);

          const updates: Record<string, unknown> = {
            instagram_handle: profile?.handle ?? handle,
            instagram_followers: profile?.followers ?? 0,
            instagram_bio: profile?.bio ?? null,
            instagram_last_post_at: profile?.latestPostAt ?? null,
            instagram_is_active: profile?.isActive ?? null,
          };
          if (override === null || override === undefined) {
            updates.qualified = isCoach;
          }

          const { error: igErr } = await supabase
            .from("leads")
            .update(updates)
            .eq("place_id", placeId);
          if (!igErr) processed++;
          if (!profile) unreachable++;
        }
        if (unreachable > 0) {
          send({
            stage: "filtering",
            message: `${unreachable} handles were unreachable (private / deleted) — marked as tried so they don't loop`,
          });
        }

        const remaining = totalPending - placeIds.length;
        send({
          stage: "done",
          message: `Enriched ${processed}/${placeIds.length} this batch · ${remaining} pending`,
          counts: { processed, remaining },
        });
      } catch (err) {
        send({
          stage: "error",
          message: `Enrich error: ${(err as Error).message}`,
          counts: { remaining: -1 },
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
