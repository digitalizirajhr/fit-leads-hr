"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface Props {
  leadId: string;
  qualified: boolean; // current effective state
  qualifiedOverride: boolean | null;
  className?: string;
}

/**
 * 3-state cycle button:
 *   override = null  → indicator shows the rule's verdict (✓ or ✗) in muted color
 *   override = true  → ✓ in solid yellow (manual yes)
 *   override = false → ✗ in solid red (manual no)
 *
 * Click cycles: null → true → false → null. Each click PATCHes /api/leads/[id]
 * with { qualified_override: <next> } and refreshes the route to pick up the
 * server-recomputed `qualified` value.
 */
export function QualifiedToggle({ leadId, qualified, qualifiedOverride, className }: Props) {
  const router = useRouter();
  const [override, setOverride] = useState<boolean | null>(qualifiedOverride);
  const [effective, setEffective] = useState(qualified);
  const [, startTransition] = useTransition();

  function nextState(): boolean | null {
    if (override === null) return true;
    if (override === true) return false;
    return null;
  }

  function click() {
    const target = nextState();
    setOverride(target);
    // Optimistic effective: forced states match the override directly.
    // For null we'll wait for router.refresh() to bring the recomputed value.
    if (target !== null) setEffective(target);
    startTransition(async () => {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qualified_override: target }),
      });
      if (!res.ok) {
        // rollback
        setOverride(qualifiedOverride);
        setEffective(qualified);
        return;
      }
      router.refresh();
    });
  }

  const label =
    override === true
      ? "Manually qualified — click to force unqualified"
      : override === false
        ? "Manually unqualified — click to clear (back to rule)"
        : effective
          ? "Qualified by rule — click to force qualified"
          : "Not qualified by rule — click to force qualified";

  const display =
    override === true
      ? { text: "✓", style: "bg-yellow-400 text-black border-yellow-400" }
      : override === false
        ? { text: "✗", style: "bg-destructive text-destructive-foreground border-destructive" }
        : effective
          ? { text: "✓", style: "border-border text-muted-foreground hover:text-foreground" }
          : { text: "✗", style: "border-border text-muted-foreground hover:text-foreground" };

  return (
    <button
      type="button"
      onClick={click}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded border text-xs leading-none transition-colors",
        display.style,
        className,
      )}
    >
      {display.text}
    </button>
  );
}
