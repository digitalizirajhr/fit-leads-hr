"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { ScrapeEvent } from "@/lib/types";

interface Props {
  events: ScrapeEvent[];
  running: boolean;
}

const STAGE_COLOR: Record<string, string> = {
  searching: "text-foreground",
  filtering: "text-muted-foreground",
  enriching: "text-blue-300",
  saving: "text-amber-300",
  done: "text-green-300",
  error: "text-destructive",
};

export function ScrapeProgress({ events, running }: Props) {
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom as new events arrive.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events.length]);

  // Pull the latest counts off any event that includes them. Successive
  // events overwrite previous fields one-by-one (an event may report just
  // `found` without touching other counts), so we accumulate.
  const counts = events.reduce(
    (acc, e) => ({ ...acc, ...(e.counts ?? {}) }),
    {} as Record<string, number>,
  );

  const isDone = events.some((e) => e.stage === "done");
  const hasError = events.some((e) => e.stage === "error");

  if (events.length === 0 && !running) {
    return null;
  }

  return (
    <div className="space-y-3">
      {/* Counts summary */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <Stat label="Found" value={counts.found ?? 0} />
        <Stat label="Qualified" value={counts.qualified ?? 0} />
        <Stat label="New / updated" value={counts.new ?? 0} />
        <Stat label="Skipped" value={counts.skipped ?? 0} />
        <span className="ml-auto text-xs text-muted-foreground">
          {running
            ? "Running…"
            : isDone
              ? hasError
                ? "Done with errors"
                : "Done"
              : hasError
                ? "Stopped (error)"
                : "Idle"}
        </span>
      </div>

      {/* Live log */}
      <div
        ref={logRef}
        className="h-80 overflow-y-auto rounded-md border border-border bg-muted/20 p-3 font-mono text-xs leading-relaxed"
      >
        {events.map((e, i) => (
          <div key={i} className={cn("flex gap-2", STAGE_COLOR[e.stage] ?? "")}>
            <span className="shrink-0 text-muted-foreground">
              [{e.stage.padEnd(9)}]
            </span>
            <span>{e.message}</span>
          </div>
        ))}
        {running && events.at(-1)?.stage !== "done" ? (
          <div className="text-muted-foreground">…</div>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className="font-medium">{value}</span>
    </span>
  );
}
