"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LeadStatus } from "@/lib/types";

const STATUSES: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "new" },
  { value: "contacted", label: "contacted" },
  { value: "replied", label: "replied" },
  { value: "booked", label: "booked" },
  { value: "closed", label: "closed" },
  { value: "dead", label: "dead" },
];

interface Props {
  leadId: string;
  value: LeadStatus;
}

/**
 * Inline status editor. Optimistically updates the local value, fires
 * PATCH /api/leads/:id, then triggers a server refresh so any derived UI
 * (e.g. status filter counts) stays in sync.
 *
 * Note: the PATCH endpoint is built in Step 5. Until then this will 404 —
 * the dropdown still works visually but the change won't persist on reload.
 */
export function StatusSelect({ leadId, value }: Props) {
  const router = useRouter();
  const [current, setCurrent] = useState<LeadStatus>(value);
  const [isPending, startTransition] = useTransition();

  async function onChange(next: string | null) {
    if (next === null) return; // base-ui can fire null on clear; we don't expose a clear path
    const nextStatus = next as LeadStatus;
    setCurrent(nextStatus); // optimistic
    startTransition(async () => {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        setCurrent(value); // rollback
        return;
      }
      router.refresh();
    });
  }

  return (
    <Select value={current} onValueChange={onChange} disabled={isPending}>
      <SelectTrigger className="h-7 w-[110px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => (
          <SelectItem key={s.value} value={s.value}>
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
