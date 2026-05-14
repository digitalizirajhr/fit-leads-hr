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

// All URL params this component reads/writes. Used by `hasAnyFilter` and
// the page's filter parser; keep in sync with the Supabase filters in
// app/leads/page.tsx + app/api/leads/route.ts.
const FILTER_PARAMS = [
  "search",
  "city",
  "status",
  "qualified",
  "noWebsite",
  "hasPhone",
  "hasIg",
  "activeIg",
  "minRating",
  "minReviews",
  "minFollowers",
] as const;

interface Props {
  cities: string[]; // distinct city values present in the leads table
  shownCount: number; // matching the current filter
  totalCount: number; // total leads in the DB
}

export function LeadsFilters({ cities, shownCount, totalCount }: Props) {
  const router = useRouter();
  const sp = useSearchParams();

  // Local state for the text-y inputs — debounced so typing doesn't push
  // a new URL on every keystroke.
  const [search, setSearch] = useState(sp.get("search") ?? "");
  const [minRating, setMinRating] = useState(sp.get("minRating") ?? "");
  const [minReviews, setMinReviews] = useState(sp.get("minReviews") ?? "");
  const [minFollowers, setMinFollowers] = useState(sp.get("minFollowers") ?? "");

  // 350ms debounce: when an input settles, push it to the URL.
  useEffect(() => {
    const id = setTimeout(() => {
      const next = new URLSearchParams(window.location.search);
      const sync = (key: string, val: string) => {
        if (val) next.set(key, val);
        else next.delete(key);
      };
      sync("search", search);
      sync("minRating", minRating);
      sync("minReviews", minReviews);
      sync("minFollowers", minFollowers);
      next.delete("page");
      const qs = next.toString();
      router.push(qs ? `/leads?${qs}` : "/leads");
    }, 350);
    return () => clearTimeout(id);
  }, [router, search, minRating, minReviews, minFollowers]);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(sp.toString());
    if (value === null || value === "" || value === ALL) next.delete(key);
    else next.set(key, value);
    next.delete("page");
    const qs = next.toString();
    router.push(qs ? `/leads?${qs}` : "/leads");
  }

  const cityValue = sp.get("city") ?? ALL;
  const statusValue = sp.get("status") ?? ALL;
  const qualifiedOn = sp.get("qualified") !== "false"; // default ON
  const noWebsiteOn = sp.get("noWebsite") === "true"; // default OFF
  const hasPhoneOn = sp.get("hasPhone") === "true";
  const hasIgOn = sp.get("hasIg") === "true";
  const activeIgOn = sp.get("activeIg") === "true";
  const hasAnyFilter = FILTER_PARAMS.some((p) => sp.get(p));

  return (
    <div className="space-y-3 border-b border-border pb-4">
      {/* Row 1: text/select filters + status + qualified toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-56"
        />

        <Select
          value={cityValue}
          onValueChange={(v: string | null) => setParam("city", v === null || v === ALL ? null : v)}
        >
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

        <Select
          value={statusValue}
          onValueChange={(v: string | null) => setParam("status", v === null || v === ALL ? null : v)}
        >
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

      {/* Row 2: per-criterion filters mirroring the qualification rule.
          These let you slice the table by ANY criterion regardless of what
          the rule was at scrape time. AND across all enabled controls. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        <span className="text-xs uppercase tracking-wide">Criteria:</span>

        <label className="flex items-center gap-2">
          <Switch
            checked={noWebsiteOn}
            onCheckedChange={(v) => setParam("noWebsite", v ? "true" : null)}
          />
          No website
        </label>

        <label className="flex items-center gap-2">
          <Switch
            checked={hasPhoneOn}
            onCheckedChange={(v) => setParam("hasPhone", v ? "true" : null)}
          />
          Has phone
        </label>

        <label className="flex items-center gap-2">
          <Switch
            checked={hasIgOn}
            onCheckedChange={(v) => setParam("hasIg", v ? "true" : null)}
          />
          Has IG
        </label>

        <label className="flex items-center gap-2">
          <Switch
            checked={activeIgOn}
            onCheckedChange={(v) => setParam("activeIg", v ? "true" : null)}
          />
          Active IG (30d)
        </label>

        <label className="flex items-center gap-2">
          Min rating
          <Input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            max="5"
            placeholder="—"
            value={minRating}
            onChange={(e) => setMinRating(e.target.value)}
            className="h-7 w-16"
          />
        </label>

        <label className="flex items-center gap-2">
          Min reviews
          <Input
            type="number"
            inputMode="numeric"
            min="0"
            placeholder="—"
            value={minReviews}
            onChange={(e) => setMinReviews(e.target.value)}
            className="h-7 w-20"
          />
        </label>

        <label className="flex items-center gap-2">
          Min IG followers
          <Input
            type="number"
            inputMode="numeric"
            min="0"
            placeholder="—"
            value={minFollowers}
            onChange={(e) => setMinFollowers(e.target.value)}
            className="h-7 w-24"
          />
        </label>
      </div>
    </div>
  );
}
