"use client";

import { useState } from "react";
import { ScrapeForm, type ScrapeRequest } from "@/components/scrape-form";
import {
  ScrapeFormInstagram,
  type InstagramScrapeRequest,
} from "@/components/scrape-form-instagram";
import { ScrapeProgress } from "@/components/scrape-progress";
import {
  ScrapeSourcePicker,
  type ScrapeSource,
} from "@/components/scrape-source-picker";
import { DEFAULT_RULE, type QualificationRule, type ScrapeEvent } from "@/lib/types";

interface ScrapeClientProps {
  initialCustomTerms: string[];
  citiesInDb: string[];
}

/**
 * Top-level orchestrator for the /scrape multi-step form.
 *
 * Step 1: ScrapeSourcePicker — pick Google or Instagram.
 * Step 2a (Google):    ScrapeForm           → runGoogleScrape    → /api/scrape (existing)
 * Step 2b (Instagram): ScrapeFormInstagram  → runInstagramScrape → /api/scrape/discover-ig
 *
 * Both paths reuse the same SSE consumer + ScrapeProgress log component.
 */
export function ScrapeClient({ initialCustomTerms, citiesInDb }: ScrapeClientProps) {
  const [source, setSource] = useState<ScrapeSource | null>(null);
  const [events, setEvents] = useState<ScrapeEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [rule, setRule] = useState<QualificationRule>(DEFAULT_RULE);

  function append(ev: ScrapeEvent) {
    setEvents((prev) => [...prev, ev]);
  }

  /**
   * Stream SSE from `url` with `body`. Appends each event to the log; returns
   * the last event seen (so caller can inspect counts.remaining etc).
   */
  async function streamPost(url: string, body: object): Promise<ScrapeEvent | null> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const ev: ScrapeEvent = {
        stage: "error",
        message: `Network error hitting ${url}: ${(err as Error).message}`,
      };
      append(ev);
      return ev;
    }

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      const ev: ScrapeEvent = {
        stage: "error",
        message: `${url} ${res.status}: ${txt || res.statusText}`,
      };
      append(ev);
      return ev;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let last: ScrapeEvent | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload) as ScrapeEvent;
            append(ev);
            last = ev;
          } catch {
            const ev: ScrapeEvent = { stage: "error", message: `Bad SSE: ${payload}` };
            append(ev);
            last = ev;
          }
        }
      }
    }

    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload) {
        try {
          const ev = JSON.parse(payload) as ScrapeEvent;
          append(ev);
          last = ev;
        } catch {
          const ev: ScrapeEvent = { stage: "error", message: `Bad SSE: ${payload}` };
          append(ev);
          last = ev;
        }
      }
    }

    return last;
  }

  /** POST /api/scrape-runs at the start; returns the new run id (or null on failure). */
  async function createRun(
    source: "google" | "instagram",
    params: object,
  ): Promise<string | null> {
    try {
      const r = await fetch("/api/scrape-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, params }),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { id?: string };
      return j.id ?? null;
    } catch {
      return null;
    }
  }

  /** POST /api/scrape-runs/:id/finalize at the end. Best-effort. */
  async function finalizeRun(
    runId: string,
    status: "done" | "error",
    counts: { found: number; qualified: number; new: number; skipped: number },
    errorMessage: string | null = null,
  ) {
    try {
      await fetch(`/api/scrape-runs/${runId}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, counts, error_message: errorMessage }),
      });
    } catch {
      // swallow — history finalize failure shouldn't fail the whole UX
    }
  }

  /**
   * Run the enrichment phase by repeatedly POSTing to the sync /enrich
   * endpoint until counts.remaining = 0. Since we migrated from Apify to
   * HikerAPI, there's no actor cold-start tax to amortize, so this simple
   * loop replaces the previous start+poll dance entirely. Each call
   * enriches batchSize (default 50) profiles in ~10s.
   *
   * The qualification rule flows through to /enrich so post-enrichment
   * `qualified` reflects both the AI coach verdict AND the rule thresholds
   * (min followers, active IG, etc.).
   */
  async function runEnrichmentPhase(
    rule: QualificationRule,
    runId: string,
  ): Promise<{ ok: boolean; errorMessage: string | null }> {
    // 1000 batches × 50 leads = 50k max enrichments per scrape. The cap
    // exists to prevent a real bug from running up the HikerAPI bill, not
    // to limit normal usage.
    const SAFETY_CAP = 1000;
    let lastErrorMessage: string | null = null;

    for (let i = 0; i < SAFETY_CAP; i++) {
      const last = await streamPost("/api/scrape/enrich", {
        batchSize: 50,
        runId,
        rule,
      });
      if (!last) break;
      if (last.stage === "error") {
        lastErrorMessage = last.message ?? null;
        return { ok: false, errorMessage: lastErrorMessage };
      }
      const remaining = last.counts?.remaining ?? 0;
      if (remaining <= 0) break;
    }

    return { ok: true, errorMessage: null };
  }

  async function runGoogleScrape(req: ScrapeRequest) {
    setEvents([]);
    setRunning(true);
    const runId = await createRun("google", req);
    let hadError = false;
    let lastErrorMessage: string | null = null;
    const totals = { found: 0, qualified: 0, new: 0, skipped: 0 };

    try {
      if (!runId) {
        throw new Error("Could not create scrape run. No scraping was started.");
      }
      const totalCombos = req.cities.length * req.terms.length;
      let comboIdx = 0;
      append({
        stage: "searching",
        message: `Starting ${totalCombos} chunk${totalCombos === 1 ? "" : "s"} (${req.cities.length} cities × ${req.terms.length} terms)…`,
      });

      for (const city of req.cities) {
        for (const term of req.terms) {
          comboIdx++;
          append({
            stage: "searching",
            city,
            term,
            message: `Chunk ${comboIdx}/${totalCombos}: ${city} / ${term}`,
          });
          const last = await streamPost("/api/scrape", {
            city,
            term,
            skipExisting: req.skipExisting,
            rule: req.rule,
            runId,
          });
          if (last?.stage === "error") {
            hadError = true;
            lastErrorMessage = last.message ?? lastErrorMessage;
          }
          if (last?.counts) {
            totals.found += last.counts.found ?? 0;
            totals.qualified += last.counts.qualified ?? 0;
            totals.new += last.counts.new ?? 0;
            totals.skipped += last.counts.skipped ?? 0;
          }
        }
      }

      if (req.enrichInstagram) {
        append({ stage: "enriching", message: "Starting Instagram enrichment phase…" });
        const result = await runEnrichmentPhase(req.rule, runId);
        if (!result.ok) {
          hadError = true;
          lastErrorMessage = result.errorMessage ?? lastErrorMessage;
        }
      }

      append({ stage: "done", message: "Scrape complete." });
    } catch (err) {
      hadError = true;
      lastErrorMessage = (err as Error).message;
      append({ stage: "error", message: `Run failed: ${lastErrorMessage}` });
    } finally {
      setRunning(false);
      if (runId) {
        await finalizeRun(
          runId,
          hadError ? "error" : "done",
          totals,
          hadError ? lastErrorMessage : null,
        );
      }
    }
  }

  async function runInstagramScrape(req: InstagramScrapeRequest) {
    setEvents([]);
    setRunning(true);
    const runId = await createRun("instagram", req);
    let hadError = false;
    let lastErrorMessage: string | null = null;
    const totals = { found: 0, qualified: 0, new: 0, skipped: 0 };

    try {
      if (!runId) {
        throw new Error("Could not create scrape run. No scraping was started.");
      }
      append({
        stage: "searching",
        message: `Starting ${req.methods.length} IG discovery method${req.methods.length === 1 ? "" : "s"}…`,
      });
      for (const m of req.methods) {
        append({
          stage: "searching",
          message: `Method: ${m.method} (${m.values.length} value${m.values.length === 1 ? "" : "s"})`,
        });

        // Single sync call — HikerAPI has no cold-start, so the previous
        // start/poll dance is gone. The endpoint does discovery + dedup +
        // chunked upsert + link-to-run in one shot, streaming progress
        // events along the way.
        const last = await streamPost("/api/scrape/discover-ig", {
          method: m.method,
          values: m.values,
          skipExisting: req.skipExisting,
          rule: req.rule,
          runId,
        });
        if (!last) {
          const msg = `No SSE events from discover-ig for ${m.method}`;
          append({ stage: "error", message: msg });
          hadError = true;
          lastErrorMessage = msg;
          continue;
        }
        if (last.stage === "error") {
          hadError = true;
          lastErrorMessage = last.message ?? lastErrorMessage;
          continue;
        }
        if (last.counts) {
          totals.found += last.counts.found ?? 0;
          totals.qualified += last.counts.qualified ?? 0;
          totals.new += last.counts.new ?? 0;
          totals.skipped += last.counts.skipped ?? 0;
        }
      }

      // After discovery, run enrichment by looping the sync /enrich
      // endpoint until pending = 0. The enrich endpoint sets
      // qualified = (isCoach AND passes rule), respecting any manual
      // overrides.
      append({
        stage: "enriching",
        message: "Discovery done. Now enriching profiles + classifying coaches via HikerAPI…",
      });
      const result = await runEnrichmentPhase(req.rule, runId);
      if (!result.ok) {
        hadError = true;
        lastErrorMessage = result.errorMessage ?? lastErrorMessage;
      }

      append({ stage: "done", message: "IG scrape complete." });
    } catch (err) {
      hadError = true;
      lastErrorMessage = (err as Error).message;
      append({ stage: "error", message: `Run failed: ${lastErrorMessage}` });
    } finally {
      setRunning(false);
      if (runId) {
        await finalizeRun(
          runId,
          hadError ? "error" : "done",
          totals,
          hadError ? lastErrorMessage : null,
        );
      }
    }
  }

  function handleBack() {
    setSource(null);
    setEvents([]);
  }

  return (
    <>
      {source === null ? (
        <ScrapeSourcePicker onPick={setSource} />
      ) : source === "google" ? (
        <ScrapeForm
          onSubmit={runGoogleScrape}
          running={running}
          customTerms={initialCustomTerms}
          rule={rule}
          onRuleChange={setRule}
          citiesInDb={citiesInDb}
          onBack={handleBack}
        />
      ) : (
        <ScrapeFormInstagram
          onSubmit={runInstagramScrape}
          running={running}
          rule={rule}
          onRuleChange={setRule}
          citiesInDb={citiesInDb}
          onBack={handleBack}
        />
      )}
      <ScrapeProgress events={events} running={running} />
    </>
  );
}
