"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface Props {
  leadId: string;
  value: number; // 0..5
}

/**
 * Click star N to set priority to N. Click the same star again to clear (set
 * to 0). Hover preview. Same optimistic-update pattern as StatusSelect.
 */
export function PriorityStars({ leadId, value }: Props) {
  const router = useRouter();
  const [current, setCurrent] = useState(value);
  const [hover, setHover] = useState<number | null>(null);
  const [, startTransition] = useTransition();

  async function set(n: number) {
    const next = n === current ? 0 : n;
    setCurrent(next); // optimistic
    startTransition(async () => {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: next }),
      });
      if (!res.ok) {
        setCurrent(value); // rollback
        return;
      }
      router.refresh();
    });
  }

  const display = hover ?? current;

  return (
    <div className="flex items-center gap-0.5" onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= display;
        return (
          <button
            key={n}
            type="button"
            aria-label={`Set priority to ${n}`}
            onMouseEnter={() => setHover(n)}
            onClick={() => set(n)}
            className={cn(
              "text-base leading-none transition-colors",
              filled ? "text-yellow-400" : "text-muted-foreground/40 hover:text-muted-foreground",
            )}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}
