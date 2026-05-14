import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { discoverHandles, type DiscoveryMethod } from "@/lib/instagram-discovery";
import { computeQualified, normalizeQualificationRule } from "@/lib/qualification";
import { requireAuth } from "@/lib/require-auth";
import { readStringArray, rejectCrossSiteMutation } from "@/lib/request-guards";
import { linkLeadsToRun } from "@/lib/scrape-runs";
import type { QualificationRule, ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  method?: DiscoveryMethod;
  values?: string[];
  skipExisting?: boolean;
  rule?: Partial<QualificationRule>;
  runId?: string;
}

const VALID_METHODS: DiscoveryMethod[] = ["hashtag", "location", "seed", "bio_keyword"];
const UPSERT_CHUNK_SIZE = 200;

/**
 * POST /api/scrape/discover-ig — single-shot Instagram lead discovery.
 *
 * Now backed by HikerAPI (was async-polled Apify). With no cold-start, the
 * whole pipeline — fetch candidates → skip-existing → upsert → link to run
 * — runs sync inside one Vercel function call. Even a 1000-following seed
 * comfortably finishes in <30s, so we don't need the previous start/poll
 * split anymore.
 *
 * Body: { method, values, skipExisting, rule, runId }
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
  const method = body.method;
  const parsedValues = readStringArray(body.values, {
    field: "values",
    maxItems: 50,
    maxLength: 100,
  });
  if (!parsedValues.ok) return parsedValues.response;
  const values = parsedValues.value;
  const skipExisting = body.skipExisting !== false;
  const rule: QualificationRule = normalizeQualificationRule(body.rule);
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
      const term = `${method}: ${values.join(", ").slice(0, 60)}`;

      try {
        // Honor force-stop on the parent run.
        if (runId) {
          const supabaseEarly = getServerSupabase();
          const { data: runRow } = await supabaseEarly
            .from("scrape_runs")
            .select("status")
            .eq("id", runId)
            .maybeSingle();
          if (runRow?.status === "error") {
            send({ stage: "error", term, message: `Run was force-stopped by user.` });
            controller.close();
            return;
          }
        }

        send({
          stage: "searching",
          term,
          message: `Discovering via ${method} (${values.length} value${values.length === 1 ? "" : "s"})…`,
        });

        const tDiscoverStart = Date.now();
        const candidates = await discoverHandles(method, values, apiKey);
        const discoverMs = Date.now() - tDiscoverStart;
        send({
          stage: "searching",
          term,
          message: `Found ${candidates.length} candidate handles in ${discoverMs}ms`,
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

        // Skip-existing — single-shot, no .in() clauses. Two simple queries:
        //   1. all existing ig:HANDLE place_ids (PK index, fast)
        //   2. all existing non-null instagram_handle values (table scan)
        // Build a Set in memory, filter candidates.
        let toUpsert = candidates;
        let skippedExisting = 0;
        if (skipExisting) {
          const tCheckStart = Date.now();
          const [allPids, allHandles] = await Promise.all([
            supabase
              .from("leads")
              .select("place_id")
              .like("place_id", "ig:%")
              .limit(100000),
            supabase
              .from("leads")
              .select("instagram_handle")
              .not("instagram_handle", "is", null)
              .limit(100000),
          ]);
          if (allPids.error)
            throw new Error(`Existing-check (place_id): ${allPids.error.message}`);
          if (allHandles.error)
            throw new Error(`Existing-check (handle): ${allHandles.error.message}`);
          const existingSet = new Set<string>();
          for (const r of allPids.data ?? []) {
            const pid = r.place_id as string;
            if (pid.startsWith("ig:")) existingSet.add(pid.slice(3).toLowerCase());
          }
          for (const r of allHandles.data ?? []) {
            if (r.instagram_handle)
              existingSet.add((r.instagram_handle as string).toLowerCase());
          }
          toUpsert = candidates.filter((h) => !existingSet.has(h));
          skippedExisting = candidates.length - toUpsert.length;
          const checkMs = Date.now() - tCheckStart;
          send({
            stage: "filtering",
            term,
            message: `Skipped ${skippedExisting} already in DB; upserting ${toUpsert.length} new (existing-check ${checkMs}ms)`,
            counts: { skipped: skippedExisting },
          });
        }

        if (toUpsert.length === 0) {
          send({
            stage: "done",
            term,
            message: `Nothing new (${skippedExisting} already in DB).`,
            counts: {
              found: candidates.length,
              qualified: 0,
              new: 0,
              skipped: skippedExisting,
            },
          });
          controller.close();
          return;
        }

        // Upsert in chunks of UPSERT_CHUNK_SIZE so a single huge upsert
        // doesn't blow the function budget. With HikerAPI's speed, discovery
        // itself is fast; the DB writes are the slowest part.
        let totalNew = 0;
        let totalQualified = 0;
        for (let i = 0; i < toUpsert.length; i += UPSERT_CHUNK_SIZE) {
          const chunk = toUpsert.slice(i, i + UPSERT_CHUNK_SIZE);
          const rows = chunk.map((handle) => ({
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
          totalQualified += rows.filter((r) => r.qualified).length;
          totalNew += rows.length;

          const { error: upsertErr } = await supabase
            .from("leads")
            .upsert(rows, { onConflict: "place_id" });
          if (upsertErr) throw new Error(`Upsert: ${upsertErr.message}`);

          if (runId && rows.length > 0) {
            const { data: linked } = await supabase
              .from("leads")
              .select("id")
              .in("place_id", rows.map((r) => r.place_id));
            await linkLeadsToRun(runId, (linked ?? []).map((l) => l.id as string));
          }

          send({
            stage: "saving",
            term,
            message: `Upserted chunk ${Math.floor(i / UPSERT_CHUNK_SIZE) + 1} (+${rows.length}); ${toUpsert.length - i - rows.length} candidates remaining`,
          });
        }

        send({
          stage: "done",
          term,
          message: `Done ${method}: +${totalNew} raw rows. Enrichment + AI classification will run next.`,
          counts: {
            found: candidates.length,
            qualified: totalQualified,
            new: totalNew,
            skipped: skippedExisting,
          },
        });
      } catch (err) {
        send({ stage: "error", term, message: `Discovery error: ${(err as Error).message}` });
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
