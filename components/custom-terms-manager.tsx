"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  initialTerms: string[];
}

/**
 * Manages the custom search terms list — used in two places:
 *   - /settings (full management)
 *   - /scrape (inline below the term grid for quick add)
 *
 * Each add/remove fires PATCH /api/settings (auto-save). Optimistic update
 * with rollback on failure. Calls router.refresh() so any other component
 * showing custom terms (like the scrape form's checkbox grid) updates too.
 */
export function CustomTermsManager({ initialTerms }: Props) {
  const router = useRouter();
  const [terms, setTerms] = useState(initialTerms);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function persist(next: string[]): Promise<boolean> {
    setError(null);
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customTerms: next }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Save failed (${res.status})`);
      return false;
    }
    return true;
  }

  function addTerm() {
    const t = draft.trim();
    if (!t) return;
    if (terms.includes(t)) {
      setDraft("");
      return;
    }
    const previous = terms;
    const next = [...terms, t];
    setTerms(next); // optimistic
    setDraft("");
    startTransition(async () => {
      const ok = await persist(next);
      if (!ok) setTerms(previous);
      else router.refresh();
    });
  }

  function removeTerm(t: string) {
    const previous = terms;
    const next = terms.filter((x) => x !== t);
    setTerms(next); // optimistic
    startTransition(async () => {
      const ok = await persist(next);
      if (!ok) setTerms(previous);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {terms.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {terms.map((t) => (
            <li
              key={t}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-sm"
            >
              {t}
              <button
                type="button"
                onClick={() => removeTerm(t)}
                aria-label={`Remove ${t}`}
                className="ml-1 text-muted-foreground hover:text-destructive"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No custom terms yet.</p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          addTerm();
        }}
        className="flex gap-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='e.g. "yoga studio"'
          className="h-8 max-w-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!draft.trim()}>
          Add term
        </Button>
      </form>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
