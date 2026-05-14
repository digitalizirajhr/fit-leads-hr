import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { extractHandle, fetchEnrichmentDataset } from "@/lib/instagram";
import { getDiscoveryRun } from "@/lib/instagram-discovery";
import { filterCoaches } from "@/lib/coach-classifier";
import { computeQualified } from "@/lib/qualification";
import { requireAuth } from "@/lib/require-auth";
import { DEFAULT_RULE, type QualificationRule, type ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  apifyRunId?: string;
  /** The exact handles list returned by /start. We use this to know which
   *  pending leads belong to this Apify run (so we don't accidentally
   *  process leads added after the run started). */
  requestedHandles?: string[];
  /** Qualification rule to apply once we have enriched data. Without this
   *  the route falls back to the AI coach verdict alone, which means rule
   *  thresholds (min followers, active IG, etc.) are silently ignored. */
  rule?: Partial<QualificationRule>;
}

// Same poll semantics as discovery: poll Apify for up to ~45s of wall-clock,
// then either process when SUCCEEDED or emit __POLL_AGAIN__ if still RUNNING.
const POLL_INTERVAL_MS = 5_000;
const POLL_BUDGET_MS = 45_000;

// Once SUCCEEDED, process leads in chunks per /poll call so the AI calls +
// row UPDATEs fit within the 60s function budget. 50 per chunk × ~1s of AI
// per bio (parallel) + ~50 row updates (~30ms each) ≈ 5s comfortably.
const PROCESS_CHUNK = 50;

/**
 * POST /api/scrape/enrich/poll — polls one Apify enrichment run and, once
 * SUCCEEDED, processes the dataset in chunks.
 *
 * Each call fetches the entire Apify dataset (small JSON, fast) and only
 * works on leads whose handle is in BOTH `requestedHandles` (i.e., was in
 * the original Apify run input) AND still has NULL instagram_followers in
 * the DB. Naturally idempotent: once a chunk's rows are UPDATEd, the next
 * call sees a smaller intersection and processes the next chunk.
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
  const apifyRunId = typeof body.apifyRunId === "string" ? body.apifyRunId : "";
  const requestedHandles = Array.isArray(body.requestedHandles)
    ? body.requestedHandles.filter((h): h is string => typeof h === "string")
    : [];
  const rule: QualificationRule = { ...DEFAULT_RULE, ...(body.rule ?? {}) };

  if (!apifyRunId) {
    return new Response(
      JSON.stringify({ error: "apifyRunId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (requestedHandles.length === 0) {
    return new Response(
      JSON.stringify({ error: "requestedHandles must be non-empty" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const requestedSet = new Set(requestedHandles.map((h) => h.toLowerCase()));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ScrapeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const startTs = Date.now();

      try {
        // Phase 1: poll Apify for status until SUCCEEDED or budget exhausted.
        let run = await getDiscoveryRun(apifyRunId, apifyToken);
        while (
          run.status !== "SUCCEEDED" &&
          run.status !== "FAILED" &&
          run.status !== "ABORTED" &&
          run.status !== "TIMED-OUT" &&
          Date.now() - startTs < POLL_BUDGET_MS
        ) {
          send({
            stage: "enriching",
            message: `Apify enrich ${run.status}… (polled ${Math.round((Date.now() - startTs) / 1000)}s of ${requestedHandles.length} handles)`,
          });
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          run = await getDiscoveryRun(apifyRunId, apifyToken);
        }

        if (
          run.status === "FAILED" ||
          run.status === "ABORTED" ||
          run.status === "TIMED-OUT"
        ) {
          send({
            stage: "error",
            message: `Apify enrich run ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ""}`,
          });
          controller.close();
          return;
        }

        if (run.status !== "SUCCEEDED") {
          // Still RUNNING after our budget. Tell the client to retry.
          send({
            stage: "enriching",
            message: `Apify still ${run.status}; client will keep polling.`,
          });
          send({ stage: "enriching", message: `__POLL_AGAIN__` });
          controller.close();
          return;
        }

        // Phase 2: SUCCEEDED. Fetch the full dataset and process a chunk.
        const profiles = await fetchEnrichmentDataset(run.defaultDatasetId, apifyToken);
        const profileByHandle = new Map(profiles.map((p) => [p.handle, p]));

        const supabase = getServerSupabase();

        // Find the next chunk of pending leads whose handle is in this
        // Apify run's request list. Sorted oldest-first for determinism.
        // Pull ALL fields the qualification rule reads (lib/qualification.ts)
        // so we can re-evaluate `qualified` properly once we have enrichment
        // data — without these the rule's IG-related thresholds (min
        // followers, active IG) get silently ignored.
        const { data: pending, error: pendErr } = await supabase
          .from("leads")
          .select(
            "place_id, current_website, instagram_handle, qualified_override, has_real_website, phone, google_rating, google_review_count, city",
          )
          .is("instagram_followers", null)
          .order("created_at", { ascending: true })
          .limit(50000);
        if (pendErr) throw new Error(`Pending query: ${pendErr.message}`);

        interface ProcessItem {
          placeId: string;
          handle: string;
          override: boolean | null;
          // Carry the existing non-IG fields so we can feed the rule with
          // a complete picture (rule may also gate on phone, rating, etc.).
          hasRealWebsite: boolean | null;
          phone: string | null;
          googleRating: number | null;
          googleReviewCount: number | null;
          city: string | null;
        }
        const toProcess: ProcessItem[] = [];
        for (const row of pending ?? []) {
          if (toProcess.length >= PROCESS_CHUNK) break;
          const fromWebsite = extractHandle(row.current_website as string | null);
          const handle = (fromWebsite ?? (row.instagram_handle as string | null))?.toLowerCase();
          if (handle && requestedSet.has(handle)) {
            toProcess.push({
              placeId: row.place_id as string,
              handle,
              override: row.qualified_override as boolean | null,
              hasRealWebsite: row.has_real_website as boolean | null,
              phone: row.phone as string | null,
              googleRating: row.google_rating as number | null,
              googleReviewCount: row.google_review_count as number | null,
              city: row.city as string | null,
            });
          }
        }

        if (toProcess.length === 0) {
          // Nothing left from this Apify run to process — we're done. Any
          // currently-pending leads have handles that weren't in this run
          // (e.g., upserted after /start). The orchestrator's outer loop
          // will pick them up by calling /start again.
          send({
            stage: "done",
            message: `Apify run fully processed (${profiles.length} profiles returned for ${requestedHandles.length} requested handles).`,
            counts: { processed: 0, remaining: 0 },
          });
          controller.close();
          return;
        }

        send({
          stage: "enriching",
          message: `Apify done. Processing ${toProcess.length} leads from dataset (${profiles.length} profiles available)…`,
        });

        // AI classification — parallel, only for leads with a returned profile.
        const profilesForAi = toProcess
          .map((item) => profileByHandle.get(item.handle))
          .filter((p): p is NonNullable<typeof p> => Boolean(p));
        const coaches = await filterCoaches(profilesForAi, {
          onAiCall: (n) =>
            send({
              stage: "filtering",
              message: `${n} bios sent to Claude Haiku for coach classification (parallel)`,
            }),
          onAiError: (n) =>
            send({
              stage: "filtering",
              message: `${n} AI calls failed — those profiles kept as not-qualified (fail-open)`,
            }),
        });
        const coachHandles = new Set(coaches.map((c) => c.handle.toLowerCase()));

        // Per-row UPDATE. Sequential is fine — 50 updates × ~30ms = ~1.5s.
        let processed = 0;
        let unreachable = 0;
        let updatedRowCount = 0;
        let qualifiedThisChunk = 0;
        let droppedByRule = 0;
        for (const item of toProcess) {
          const profile = profileByHandle.get(item.handle);
          const isCoach = profile ? coachHandles.has(item.handle) : false;

          const updates: Record<string, unknown> = {
            instagram_handle: profile?.handle ?? item.handle,
            instagram_followers: profile?.followers ?? 0,
            instagram_bio: profile?.bio ?? null,
            instagram_last_post_at: profile?.latestPostAt ?? null,
            instagram_is_active: profile?.isActive ?? null,
          };
          // Only auto-set qualified when there's no manual override on this
          // lead. Qualified now = coach AND passes the qualification rule
          // (which can have thresholds the AI verdict alone doesn't know
          // about, like min IG followers, requires-active-IG, etc.).
          if (item.override === null || item.override === undefined) {
            const passesRule = computeQualified(
              {
                has_real_website: item.hasRealWebsite ?? false,
                phone: item.phone,
                google_rating: item.googleRating,
                google_review_count: item.googleReviewCount,
                instagram_handle: profile?.handle ?? item.handle,
                instagram_is_active: profile?.isActive ?? null,
                instagram_followers: profile?.followers ?? 0,
                city: item.city,
              },
              rule,
            );
            const finalQualified = isCoach && passesRule;
            updates.qualified = finalQualified;
            if (finalQualified) qualifiedThisChunk++;
            else if (isCoach && !passesRule) droppedByRule++;
          }

          const { data: updatedRows, error: igErr } = await supabase
            .from("leads")
            .update(updates)
            .eq("place_id", item.placeId)
            .select("place_id");
          if (!igErr) processed++;
          if (updatedRows && updatedRows.length > 0) updatedRowCount++;
          if (!profile) unreachable++;
        }
        if (unreachable > 0) {
          send({
            stage: "filtering",
            message: `${unreachable} handles were unreachable (private / deleted) — marked as tried (instagram_followers=0)`,
          });
        }
        if (droppedByRule > 0) {
          send({
            stage: "filtering",
            message: `${droppedByRule} confirmed coaches dropped by qualification rule (e.g. below min followers / inactive on IG)`,
          });
        }
        send({
          stage: "filtering",
          message: `${qualifiedThisChunk}/${toProcess.length} leads qualified this chunk (coach AND rule)`,
        });
        send({
          stage: "filtering",
          message: `DB confirmed ${updatedRowCount}/${toProcess.length} rows updated (sample place_id: ${toProcess[0].placeId})`,
        });

        // How many leads from THIS Apify run are still pending? If > 0 the
        // client re-calls /poll and we process the next chunk.
        const stillPending = (pending ?? []).filter((row) => {
          const fromWebsite = extractHandle(row.current_website as string | null);
          const h = (fromWebsite ?? (row.instagram_handle as string | null))?.toLowerCase();
          return h && requestedSet.has(h);
        }).length;
        const remainingFromThisRun = stillPending - toProcess.length;

        if (remainingFromThisRun > 0) {
          send({
            stage: "filtering",
            message: `Processed chunk of ${processed}; ${remainingFromThisRun} more from this Apify run still to process.`,
          });
          send({ stage: "enriching", message: `__POLL_AGAIN__` });
          controller.close();
          return;
        }

        send({
          stage: "done",
          message: `Apify run fully processed: ${processed} leads enriched in this chunk.`,
          counts: { processed, remaining: 0 },
        });
      } catch (err) {
        send({
          stage: "error",
          message: `Enrich poll error: ${(err as Error).message}`,
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
