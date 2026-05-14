"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface Props {
  runId: string;
}

/**
 * Force-stop button for /history/[id]. Marks the scrape_runs row as 'error'
 * via /api/scrape-runs/:id/stop. The polling endpoints check this status
 * at the top of each call and abort early, so once the next /poll cycle
 * (~50s) ticks the orchestrating tab will stop firing requests.
 *
 * NOTE: this only stops the SERVER work. The orchestrating browser tab keeps
 * looping until the next /poll call returns the abort signal. To stop
 * everything immediately, the user should also close the /scrape tab.
 */
export function StopRunButton({ runId }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleStop() {
    if (
      !confirm(
        "Force-stop this run?\n\nThis marks the run as stopped and the next /poll cycle (within ~50s) will abort. To stop instantly, also close any open /scrape browser tabs.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/scrape-runs/${runId}/stop`, {
          method: "POST",
        });
        if (!res.ok && res.status !== 204) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="destructive"
        size="sm"
        onClick={handleStop}
        disabled={isPending}
      >
        {isPending ? "Stopping…" : "Stop run"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
