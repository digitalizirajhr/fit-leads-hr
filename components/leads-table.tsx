"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ExportDialog } from "@/components/export-dialog";
import { StatusSelect } from "@/components/status-select";
import { PriorityStars } from "@/components/priority-stars";
import { croatianSort, formatRelativeTime, truncateUrl } from "@/lib/format";
import type { Lead } from "@/lib/types";

type SortKey = "name" | "city" | "followers" | "priority" | "lastContacted";
type SortDir = "asc" | "desc";

interface Props {
  leads: Lead[];
}

/**
 * Client-side table. Receives already-filtered server-side data, handles only:
 *  - row selection (for export, wired in Step 9)
 *  - column sorting (no extra fetch — sorts the array we already have)
 *
 * Filters live in the URL and re-render the parent server component, which
 * passes a fresh `leads` array down. Inline edits (status, priority) hit
 * /api/leads/:id and call router.refresh(), which also flows through here.
 */
export function LeadsTable({ leads }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const allOnPageSelected = leads.length > 0 && leads.every((l) => selected.has(l.id));

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allOnPageSelected) setSelected(new Set());
    else setSelected(new Set(leads.map((l) => l.id)));
  }

  function clickHeader(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "priority" || key === "followers" || key === "lastContacted" ? "desc" : "asc");
    }
  }

  const sorted = useMemo(() => {
    const arr = [...leads];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = croatianSort(a.name, b.name);
          break;
        case "city":
          cmp = croatianSort(a.city, b.city);
          break;
        case "followers":
          cmp = (a.instagram_followers ?? -1) - (b.instagram_followers ?? -1);
          break;
        case "priority":
          cmp = a.priority - b.priority;
          break;
        case "lastContacted":
          cmp =
            new Date(a.contacted_at ?? 0).getTime() - new Date(b.contacted_at ?? 0).getTime();
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [leads, sortKey, sortDir]);

  if (leads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
        <p>No leads match these filters.</p>
        <Link href="/leads" className="text-sm underline underline-offset-4">
          Clear filters
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox checked={allOnPageSelected} onCheckedChange={toggleAll} aria-label="Select all" />
              </TableHead>
              <SortableTH onClick={() => clickHeader("name")} active={sortKey === "name"} dir={sortDir}>
                Name
              </SortableTH>
              <SortableTH onClick={() => clickHeader("city")} active={sortKey === "city"} dir={sortDir}>
                City
              </SortableTH>
              <TableHead>Phone</TableHead>
              <TableHead>Website</TableHead>
              <SortableTH onClick={() => clickHeader("followers")} active={sortKey === "followers"} dir={sortDir}>
                Instagram
              </SortableTH>
              <TableHead>Status</TableHead>
              <SortableTH onClick={() => clickHeader("priority")} active={sortKey === "priority"} dir={sortDir}>
                Priority
              </SortableTH>
              <SortableTH
                onClick={() => clickHeader("lastContacted")}
                active={sortKey === "lastContacted"}
                dir={sortDir}
              >
                Last contacted
              </SortableTH>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((lead) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                selected={selected.has(lead.id)}
                onToggle={() => toggleRow(lead.id)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{selected.size > 0 ? `${selected.size} selected` : ""}</span>
        <ExportDialog selectedIds={Array.from(selected)} />
      </div>
    </div>
  );
}

function SortableTH({
  children,
  onClick,
  active,
  dir,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: SortDir;
}) {
  return (
    <TableHead>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 text-left font-medium hover:text-foreground"
      >
        {children}
        {active ? <span className="text-xs">{dir === "asc" ? "▲" : "▼"}</span> : null}
      </button>
    </TableHead>
  );
}

function LeadRow({
  lead,
  selected,
  onToggle,
}: {
  lead: Lead;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${lead.name}`} />
      </TableCell>
      <TableCell className="font-medium">
        <Link href={`/leads/${lead.id}`} className="hover:underline underline-offset-4">
          {lead.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{lead.city ?? "—"}</TableCell>
      <TableCell>
        {lead.phone ? (
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(lead.phone!)}
            className="text-left hover:underline underline-offset-4"
            title="Click to copy"
          >
            {lead.phone}
          </button>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {lead.current_website ? (
          <a
            href={lead.current_website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs hover:underline underline-offset-4"
          >
            {truncateUrl(lead.current_website)}
          </a>
        ) : (
          <Badge variant="destructive" className="font-normal">
            ❌ none
          </Badge>
        )}
      </TableCell>
      <TableCell>
        {lead.instagram_handle ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span>@{lead.instagram_handle}</span>
            {lead.instagram_followers != null ? (
              <Badge
                variant="secondary"
                className={
                  lead.instagram_is_active
                    ? "bg-green-900/40 text-green-300 hover:bg-green-900/40"
                    : "bg-muted text-muted-foreground hover:bg-muted"
                }
              >
                {Intl.NumberFormat("hr").format(lead.instagram_followers)}
              </Badge>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <StatusSelect leadId={lead.id} value={lead.status} />
      </TableCell>
      <TableCell>
        <PriorityStars leadId={lead.id} value={lead.priority} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatRelativeTime(lead.contacted_at)}
      </TableCell>
      <TableCell>
        <Link href={`/leads/${lead.id}`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
          View
        </Link>
      </TableCell>
    </TableRow>
  );
}
