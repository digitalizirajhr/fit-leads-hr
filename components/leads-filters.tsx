"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LeadStatus } from "@/lib/types";

const STATUSES: LeadStatus[] = ["new", "contacted", "replied", "booked", "closed", "dead"];
const ALL = "__all__"; // sentinel for "no filter" inside the Select

interface Props {
  cities: string[]; // distinct city values present in the leads table
  shownCount: number; // matching the current filter
  totalCount: number; // total leads in the DB
}

export function LeadsFilters({ cities, shownCount, totalCount }: Props) {
  const router = useRouter();
  const sp = useSearchParams();

  // Local state for the search input — debounced so we don't push a new URL
  // on every keystroke. Reads initial value from URL.
  const [search, setSearch] = useState(sp.get("search") ?? "");

  // 350ms debounce: when `search` settles, push it to the URL.
  useEffect(() => {
    const id = setTimeout(() => {
      const next = new URLSearchParams(sp.toString());
      if (search) next.set("search", search);
      else next.delete("search");
      const qs = next.toString();
      router.push(qs ? `/leads?${qs}` : "/leads");
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(sp.toString());
    if (value === null || value === "" || value === ALL) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.push(qs ? `/leads?${qs}` : "/leads");
  }

  const cityValue = sp.get("city") ?? ALL;
  const statusValue = sp.get("status") ?? ALL;
  const qualifiedOn = sp.get("qualified") !== "false"; // default ON
  const noWebsiteOn = sp.get("noWebsite") === "true"; // default OFF
  const hasAnyFilter =
    sp.get("search") || sp.get("city") || sp.get("status") || sp.get("qualified") || sp.get("noWebsite");

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
      <Input
        placeholder="Search by name…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-8 w-56"
      />

      <Select value={cityValue} onValueChange={(v) => setParam("city", v === ALL ? null : v)}>
        <SelectTrigger className="h-8 w-44">
          <SelectValue placeholder="All cities" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All cities</SelectItem>
          {cities.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={statusValue} onValueChange={(v) => setParam("status", v === ALL ? null : v)}>
        <SelectTrigger className="h-8 w-36">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={qualifiedOn}
          onCheckedChange={(v) => setParam("qualified", v ? null : "false")}
        />
        Qualified only
      </label>

      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={noWebsiteOn}
          onCheckedChange={(v) => setParam("noWebsite", v ? "true" : null)}
        />
        No website only
      </label>

      <Badge variant="secondary" className="ml-auto">
        Showing {shownCount} of {totalCount} leads
      </Badge>

      {hasAnyFilter ? (
        <Link
          href="/leads"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}
