"use client";

import { useState } from "react";
import { ScrapeForm, type ScrapeRequest } from "@/components/scrape-form";
import { ScrapeProgress } from "@/components/scrape-progress";
import type { ScrapeEvent } from "@/lib/types";

/**
 * The interactive part of /scrape. Lives in its own client component so the
 * page wrapper can stay a server component and decide whether to render this
 * (local) or a "local only" message (deployed).
 */
export function ScrapeClient() {
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

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const ev = JSON.parse(payload) as ScrapeEvent;
              setEvents((prev) => [...prev, ev]);
            } catch {
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
    <>
      <ScrapeForm onSubmit={runScrape} running={running} />
      <ScrapeProgress events={events} running={running} />
    </>
  );
}
