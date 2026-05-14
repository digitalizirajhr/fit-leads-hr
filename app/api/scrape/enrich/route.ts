import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { extractHandle, enrichAll } from "@/lib/instagram";
import { filterCoaches } from "@/lib/coach-classifier";
import { computeQualified, normalizeQualificationRule } from "@/lib/qualification";
import { requireAuth } from "@/lib/require-auth";
import { rejectCrossSiteMutation } from "@/lib/request-guards";
import type { QualificationRule, ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  runId?: string | null;
  /** How many leads to enrich per request. With HikerAPI we can comfortably
   *  do 50 in ~10 seconds total — no cold-start tax like Apify had. */
  batchSize?: number;
  /** Rule applied AFTER enrichment so qualified reflects real data (min
   *  followers, active IG, etc.), not just the AI coach verdict. */
  rule?: Partial<QualificationRule>;
}

const DEFAULT_BATCH = 50;
const MIN_BATCH = 1;
const MAX_BATCH = 100;

interface PendingLeadRow {
  place_id: string;
  current_website: string | null;
  instagram_handle: string | null;
  qualified_override: boolean | null;
  has_real_website: boolean | null;
  phone: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  city: string | null;
}

function normalizeLeadJoin(rows: Array<{ leads: unknown }> | null): PendingLeadRow[] {
  const out: PendingLeadRow[] = [];
  for (const row of rows ?? []) {
    const value = row.leads;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(value as PendingLeadRow);
    } else if (Array.isArray(value)) {
      for (const lead of value) out.push(lead as PendingLeadRow);
    }
  }
  return out;
}

/**
 * POST /api/scrape/enrich — process the next batch of pending IG enrichments.
 *
 * Now backed by HikerAPI (was async-polled Apify). Each call is sync:
 *   1. Find next batchSize pending leads (NULL instagram_followers).
 *   2. Fetch their profiles from Hiker in parallel (~10 concurrent).
 *   3. Run AI coach classifier on the bios (parallel).
 *   4. Per row: UPDATE with profile data + qualified = isCoach AND passesRule.
 *
 * The client loops this endpoint until counts.remaining = 0.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  const blocked = rejectCrossSiteMutation(req);
  if (blocked) return blocked;

  const apiKey = process.env.HIKERAPI_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "HIKERAPI_KEY is not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const body: Body = await req.json().catch(() => ({}));
  const runId = typeof body.runId === "string" ? body.runId : "";
  if (!runId) {
    return new Response(
      JSON.stringify({ error: "runId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const batchSize = clamp(
    typeof body.batchSize === "number" ? body.batchSize : DEFAULT_BATCH,
    MIN_BATCH,
    MAX_BATCH,
  );
  const rule: QualificationRule = normalizeQualificationRule(body.rule);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ScrapeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const supabase = getServerSupabase();
        const { data: runRow, error: runErr } = await supabase
          .from("scrape_runs")
          .select("status")
          .eq("id", runId)
          .maybeSingle();
        if (runErr) throw new Error(`Run status lookup: ${runErr.message}`);
        if (!runRow) throw new Error("Run not found");
        if (runRow.status === "error") {
          send({ stage: "error", message: "Run was stopped before enrichment." });
          controller.close();
          return;
        }

        // True run-scoped pending count via head+count exact.
        const { count: truePendingCount } = await supabase
          .from("scrape_run_leads")
          .select("leads!inner(instagram_followers)", { count: "exact", head: true })
          .eq("run_id", runId)
          .is("leads.instagram_followers", null);

        // Pull only pending leads linked to this scrape run. ALL fields the
        // qualification rule reads are included so we can recompute properly.
        const { data: pendingRows, error: pendErr } = await supabase
          .from("scrape_run_leads")
          .select(
            "leads!inner(place_id, current_website, instagram_handle, instagram_followers, qualified_override, has_real_website, phone, google_rating, google_review_count, city)",
          )
          .eq("run_id", runId)
          .is("leads.instagram_followers", null)
          .limit(50000);
        if (pendErr) throw new Error(`Pending query: ${pendErr.message}`);
        const pending = normalizeLeadJoin(
          (pendingRows ?? []) as Array<{ leads: unknown }>,
        );

        interface ProcessItem {
          placeId: string;
          handle: string;
          override: boolean | null;
          hasRealWebsite: boolean | null;
          phone: string | null;
          googleRating: number | null;
          googleReviewCount: number | null;
          city: string | null;
        }
        const handlesByPlaceId = new Map<string, ProcessItem>();
        for (const row of pending) {
          const fromWebsite = extractHandle(row.current_website as string | null);
          const handle = (fromWebsite ?? (row.instagram_handle as string | null))?.toLowerCase();
          if (handle) {
            handlesByPlaceId.set(row.place_id as string, {
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

        const totalDerivable = handlesByPlaceId.size;
        const totalPending = truePendingCount ?? totalDerivable;

        if (totalDerivable === 0) {
          send({
            stage: "done",
            message: `No leads with derivable IG handles need enrichment (${totalPending} pending in this run).`,
            counts: { processed: 0, remaining: 0 },
          });
          controller.close();
          return;
        }

        // Pick next batch.
        const placeIds = Array.from(handlesByPlaceId.keys()).slice(0, batchSize);
        const items = placeIds.map((pid) => handlesByPlaceId.get(pid)!);
        const handles = items.map((it) => it.handle);

        send({
          stage: "enriching",
          message: `Enriching ${items.length} of ${totalDerivable} derivable handles (${totalPending} pending in this run) via HikerAPI…`,
        });

        const tEnrichStart = Date.now();
        const enriched = await enrichAll(handles, apiKey);
        const enrichMs = Date.now() - tEnrichStart;
        send({
          stage: "filtering",
          message: `HikerAPI returned ${enriched.size}/${items.length} profiles in ${enrichMs}ms`,
        });

        // AI classification — parallel, only for handles that came back.
        const profilesForAi = items
          .map((it) => enriched.get(it.handle))
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

        // Per-row UPDATE. ALWAYS write a row even when Hiker returned no
        // profile (private/deleted) — instagram_followers = 0 sentinel so
        // we don't keep re-picking the same handle.
        let processed = 0;
        let unreachable = 0;
        let updatedRowCount = 0;
        let qualifiedThisBatch = 0;
        let droppedByRule = 0;
        for (const item of items) {
          const profile = enriched.get(item.handle);
          const isCoach = profile ? coachHandles.has(item.handle) : false;

          const updates: Record<string, unknown> = {
            instagram_handle: profile?.handle ?? item.handle,
            instagram_followers: profile?.followers ?? 0,
            instagram_bio: profile?.bio ?? null,
            instagram_last_post_at: profile?.latestPostAt ?? null,
            instagram_is_active: profile?.isActive ?? null,
          };
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
            if (finalQualified) qualifiedThisBatch++;
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
          message: `DB confirmed ${updatedRowCount}/${items.length} rows updated · ${qualifiedThisBatch} qualified this batch`,
        });

        const remaining = totalDerivable - items.length;
        send({
          stage: "done",
          message: `Enriched ${processed}/${items.length} this batch · ${remaining} derivable handles pending`,
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
