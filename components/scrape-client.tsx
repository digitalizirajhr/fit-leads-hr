"use client";

import { useState } from "react";
import { ScrapeForm, type ScrapeRequest } from "@/components/scrape-form";
import { ScrapeProgress } from "@/components/scrape-progress";
import type { ScrapeEvent } from "@/lib/types";

/**
 * Orchestrator for the chunked scrape pipeline.
 *
 * Why chunked: a full Croatia sweep is ~5-15 minutes total — way past any
 * Vercel function timeout. So we split the work into per-(city × term)
 * requests, each well under 60s. The browser does the looping; the
 * server endpoints stay short-lived.
 *
 * Flow:
 *   1. For each (city, term) combo selected in the form: POST /api/scrape
 *      and stream its events into the log.
 *   2. If "Enrich with Instagram" is on: POST /api/scrape/enrich repeatedly
 *      until the server reports `remaining: 0`.
 *   3. Emit a final `done` event with overall summary.
 *
 * Errors in any single chunk emit an error event but DON'T stop the loop —
 * a transient quota hiccup or one bad city shouldn't waste the rest.
 */
interface ScrapeClientProps {
  initialCustomTerms: string[];
}

export function ScrapeClient({ initialCustomTerms }: ScrapeClientProps) {
  const [events, setEvents] = useState<ScrapeEvent[]>([]);
  const [running, setRunning] = useState(false);

  function append(ev: ScrapeEvent) {
    setEvents((prev) => [...prev, ev]);
  }

  /** Stream SSE from `url` with `body`. Appends each event into log; returns the
   *  last event seen (so caller can inspect counts.remaining etc). */
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

    return last;
  }

  async function runScrape(req: ScrapeRequest) {
    setEvents([]);
    setRunning(true);

    try {
      const totalCombos = req.cities.length * req.terms.length;
      let comboIdx = 0;

      // ---- Phase 1: per-(city, term) scrape ----
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
          await streamPost("/api/scrape", {
            city,
            term,
            skipExisting: req.skipExisting,
          });
        }
      }

      // ---- Phase 2: IG enrichment (optional, polled until remaining=0) ----
      if (req.enrichInstagram) {
        append({
          stage: "enriching",
          message: "Starting Instagram enrichment phase…",
        });
        // Hard safety cap so we never loop forever on a server-side bug.
        const SAFETY_CAP = 300;
        let i = 0;
        while (i++ < SAFETY_CAP) {
          const last = await streamPost("/api/scrape/enrich", { batchSize: 3 });
          if (!last) break;
          if (last.stage === "error") break; // server reported a problem
          const remaining = last.counts?.remaining ?? 0;
          if (remaining <= 0) break;
        }
        if (i >= SAFETY_CAP) {
          append({
            stage: "error",
            message: `Hit safety cap (${SAFETY_CAP} batches). Stopping enrichment loop.`,
          });
        }
      }

      append({ stage: "done", message: "Scrape complete." });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <ScrapeForm
        onSubmit={runScrape}
        running={running}
        customTerms={initialCustomTerms}
      />
      <ScrapeProgress events={events} running={running} />
    </>
  );
}
