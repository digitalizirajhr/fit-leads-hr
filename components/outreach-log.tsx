"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/format";
import type { OutreachEntry } from "@/lib/types";

interface Props {
  entries: OutreachEntry[];
}

const METHOD_LABEL: Record<string, string> = {
  instagram_dm: "IG DM",
  email: "Email",
  phone: "Phone",
  whatsapp: "WhatsApp",
  other: "Other",
};

export function OutreachLog({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No outreach yet. Add the first entry below.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {entries.map((e) => (
        <Entry key={e.id} entry={e} />
      ))}
    </ul>
  );
}

function Entry({ entry }: { entry: OutreachEntry }) {
  const [open, setOpen] = useState(false);
  const message = entry.message ?? "";
  const response = entry.response ?? "";
  const snippet = message.length > 90 ? message.slice(0, 90) + "…" : message;
  const hasMore = message.length > 90 || !!response;

  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary" className="font-normal">
          {METHOD_LABEL[entry.method] ?? entry.method}
        </Badge>
        <span>{formatRelativeTime(entry.created_at)}</span>
        <span title={new Date(entry.created_at).toLocaleString("hr")} className="ml-auto">
          {new Date(entry.created_at).toLocaleDateString("hr")}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-foreground/90">{open ? message : snippet}</p>
      {open && response ? (
        <div className="mt-2 border-l-2 border-muted pl-3 text-muted-foreground">
          <p className="mb-1 text-xs font-medium">Response</p>
          <p className="whitespace-pre-wrap">{response}</p>
        </div>
      ) : null}
      {hasMore ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-2 text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          {open ? "Show less" : "View full"}
        </button>
      ) : null}
    </li>
  );
}
