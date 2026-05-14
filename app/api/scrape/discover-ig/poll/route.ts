import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  getDiscoveryRun,
  fetchDiscoveryHandles,
  type DiscoveryMethod,
} from "@/lib/instagram-discovery";
import { computeQualified } from "@/lib/qualification";
import { requireAuth } from "@/lib/require-auth";
import { linkLeadsToRun } from "@/lib/scrape-runs";
import { DEFAULT_RULE, type QualificationRule, type ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  apifyRunId?: string;
  method?: DiscoveryMethod;
  skipExisting?: boolean;
  rule?: Partial<QualificationRule>;
  /** scrape_runs row id, for /history attribution. */
  runId?: string;
}

const VALID_METHODS: DiscoveryMethod[] = ["hashtag", "location", "seed", "bio_keyword"];

// Poll interval + budget within ONE request. We poll Apify every POLL_INTERVAL_MS
// for up to POLL_BUDGET_MS of wall-clock; if the run is still RUNNING when we
// hit the budget, we send a `still_polling` SSE event and close the stream so
// the client can retry. Each Vercel call stays well under 60s.
const POLL_INTERVAL_MS = 5_000;
const POLL_BUDGET_MS = 50_000;

/**
 * POST /api/scrape/discover-ig/poll
 *
 * Body: { apifyRunId, method, skipExisting, rule, runId }
 *
 * Polls Apify until the run hits a terminal status or our wall-clock
 * budget runs out. On SUCCEEDED: fetches the dataset, dedupes handles,
 * skip-existing, upserts raw rows, links to scrape_runs, sends `done`.
 * Otherwise sends `still_polling` so the client retries.
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
  const method = body.method;
  const skipExisting = body.skipExisting !== false;
  const rule: QualificationRule = { ...DEFAULT_RULE, ...(body.rule ?? {}) };
  const runId = typeof body.runId === "string" ? body.runId : null;

  if (!apifyRunId) {
    return new Response(
      JSON.stringify({ error: "apifyRunId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!method || !VALID_METHODS.includes(method)) {
    return new Response(
      JSON.stringify({ error: `method must be one of ${VALID_METHODS.join(", ")}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ScrapeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const term = `${method} run=${apifyRunId.slice(0, 8)}`;
      const startTs = Date.now();

      try {
        // Poll loop within budget.
        while (Date.now() - startTs < POLL_BUDGET_MS) {
          const run = await getDiscoveryRun(apifyRunId, apifyToken);

          if (run.status === "SUCCEEDED") {
            // Done — fetch dataset + process.
            send({ stage: "searching", term, message: `Apify finished — fetching results…` });
            const candidates = await fetchDiscoveryHandles(method, run.defaultDatasetId, apifyToken);
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

            // Skip-existing
            let toUpsert = candidates;
            let skippedExisting = 0;
            if (skipExisting) {
              const placeIds = candidates.map((h) => `ig:${h}`);
              const [byPid, byHandle] = await Promise.all([
                supabase.from("leads").select("place_id").in("place_id", placeIds),
                supabase.from("leads").select("instagram_handle").in("instagram_handle", candidates),
              ]);
              if (byPid.error) throw new Error(`Existing-check (place_id): ${byPid.error.message}`);
              if (byHandle.error) throw new Error(`Existing-check (handle): ${byHandle.error.message}`);

              const existingSet = new Set<string>();
              for (const r of byPid.data ?? []) {
                const pid = r.place_id as string;
                if (pid.startsWith("ig:")) existingSet.add(pid.slice(3).toLowerCase());
              }
              for (const r of byHandle.data ?? []) {
                if (r.instagram_handle) existingSet.add((r.instagram_handle as string).toLowerCase());
              }
              toUpsert = candidates.filter((h) => !existingSet.has(h));
              skippedExisting = candidates.length - toUpsert.length;
              send({
                stage: "filtering",
                term,
                message: `Skipped ${skippedExisting} already in DB; upserting ${toUpsert.length} raw rows`,
                counts: { skipped: skippedExisting },
              });
            }

            if (toUpsert.length === 0) {
              send({
                stage: "done",
                term,
                message: `Nothing new (${skippedExisting} already in DB).`,
                counts: { found: candidates.length, qualified: 0, new: 0, skipped: skippedExisting },
              });
              controller.close();
              return;
            }

            // Upsert raw rows (enrichment + AI classification happen later
            // via the /api/scrape/enrich polling loop).
            const rows = toUpsert.map((handle) => ({
              place_id: `ig:${handle}`,
              name: handle,
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
              message: `Upserting ${rows.length} raw handles…`,
            });

            const { error: upsertErr } = await supabase
              .from("leads")
              .upsert(rows, { onConflict: "place_id" });
            if (upsertErr) throw new Error(`Upsert: ${upsertErr.message}`);

            // Link to /history run
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
              message: `Done ${method}: +${rows.length} raw rows. Enrichment + AI classification will run next.`,
              counts: {
                found: candidates.length,
                qualified: qualifiedCount,
                new: rows.length,
                skipped: skippedExisting,
              },
            });
            controller.close();
            return;
          }

          if (
            run.status === "FAILED" ||
            run.status === "ABORTED" ||
            run.status === "TIMED-OUT" ||
            run.status === "ABORTING" ||
            run.status === "TIMING-OUT"
          ) {
            send({
              stage: "error",
              term,
              message: `Apify run ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ""}`,
            });
            controller.close();
            return;
          }

          // Still RUNNING (or READY). Tell the user, wait, poll again.
          send({
            stage: "searching",
            term,
            message: `Apify still ${run.status}… (polled ${Math.round((Date.now() - startTs) / 1000)}s so far)`,
          });
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        // Budget exhausted — tell the client to call us again.
        send({
          stage: "filtering",
          term,
          message: `Apify still running; client will keep polling.`,
        });
        // Custom marker stage so the client knows to retry instead of treating
        // this as `done`.
        send({
          stage: "enriching",
          term,
          message: `__POLL_AGAIN__`,
        });
      } catch (err) {
        send({ stage: "error", term, message: `Poll error: ${(err as Error).message}` });
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
