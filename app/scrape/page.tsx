"use client";

import { useState } from "react";
import { ScrapeForm, type ScrapeRequest } from "@/components/scrape-form";
import { ScrapeProgress } from "@/components/scrape-progress";
import type { ScrapeEvent } from "@/lib/types";

/**
 * /scrape — the form + live progress page.
 *
 * Browsers' native EventSource doesn't support POST, so we use fetch + a
 * ReadableStream consumer to read the SSE stream from /api/scrape line by
 * line. Each "data: {...}\n\n" frame becomes one ScrapeEvent appended to
 * local state, which <ScrapeProgress/> renders.
 */
export default function ScrapePage() {
  const [events, setEvents] = useState<ScrapeEvent[]>([]);
  const [running, setRunning] = useState(false);

  async function runScrape(req: ScrapeRequest) {
    setEvents([]);
    setRunning(true);

    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        setEvents((p) => [
          ...p,
          {
            stage: "error",
            message: `Request failed (${res.status}): ${errText || res.statusText}`,
          },
        ]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames end with a blank line (\n\n). Split, keep last partial.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          // A frame may contain multiple lines; we only care about "data:".
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const ev = JSON.parse(payload) as ScrapeEvent;
              setEvents((prev) => [...prev, ev]);
            } catch {
              // Malformed frame — log it as an error event so the user sees something.
              setEvents((prev) => [
                ...prev,
                { stage: "error", message: `Bad SSE frame: ${payload}` },
              ]);
            }
          }
        }
      }
    } catch (err) {
      setEvents((prev) => [
        ...prev,
        { stage: "error", message: `Network error: ${(err as Error).message}` },
      ]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto max-w-screen-lg space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Scrape</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulls fitness coaches from Google Places (New) for the selected cities and
          search terms. Filters down to those without a real website + with a phone.
          Runs locally only — pipeline can take 5–15 minutes for the full Croatia sweep.
        </p>
      </header>

      <ScrapeForm onSubmit={runScrape} running={running} />
      <ScrapeProgress events={events} running={running} />
    </main>
  );
}
