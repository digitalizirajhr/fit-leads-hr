"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  leadId: string;
  initial: string | null;
}

/**
 * Notes textarea. Autosaves on blur — that's the spec, and it's gentler than
 * keystroke debouncing (no "saving" indicator flicker while typing). Shows
 * "Saved Xs ago" once a save completes.
 */
export function NotesEditor({ leadId, initial }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const lastSaved = useRef(initial ?? "");

  // Tick every 5s so the "Saved Xs ago" label refreshes.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (savedAt === null) return;
    const id = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [savedAt]);

  async function save() {
    if (value === lastSaved.current) return;
    setSaving(true);
    const res = await fetch(`/api/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: value }),
    });
    setSaving(false);
    if (!res.ok) return;
    lastSaved.current = value;
    setSavedAt(Date.now());
    router.refresh();
  }

  return (
    <div className="space-y-1">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        placeholder="Notes — calls, follow-ups, anything you want to remember about this lead."
        className="min-h-[180px] resize-y"
      />
      <p className="h-4 text-xs text-muted-foreground">
        {saving
          ? "Saving…"
          : savedAt
            ? `Saved ${Math.max(0, Math.floor((Date.now() - savedAt) / 1000))}s ago`
            : ""}
      </p>
    </div>
  );
}
