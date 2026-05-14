# Customizable Qualification + Custom Search Terms — Implementation Plan

> **For Claude (next session):** REQUIRED SUB-SKILL: use superpowers:executing-plans to work through this task by task. Project has no automated tests — verify each task with the curl command or browser check given. Pause for Igor's confirmation at each "Verify with Igor" checkpoint before moving on.

**Goal:** Let Igor edit the qualification rule (8 criteria, all toggleable, plus 3-state per-lead manual override) and add his own search terms (persisted server-side, surfaced inline on /scrape), without touching code.

**Architecture:** New singleton `settings` table holds the qualification rule (JSONB) and the custom terms (text[]). New `qualified_override` column on `leads` carries the manual override (null/true/false). A pure `computeQualified()` function in `lib/qualification.ts` is shared by the scrape route (for new rows) and a recompute endpoint (for existing rows). New `/settings` page edits everything; `/scrape` fetches custom terms via SSR and lets Igor add new ones inline.

**Tech Stack:** Same as v1 — Next.js 14 App Router · TypeScript · Supabase JS · shadcn/ui.

**Design doc:** `docs/plans/2026-05-14-customizable-qualification-and-custom-terms-design.md` (read before starting if you're a new agent).

---

## Pre-flight: Igor runs the migration

### Task 0: Schema migration in Supabase

**Files:** none (Igor's action only)

**Step 1: Hand Igor the SQL**

Tell Igor: "Open Supabase → SQL Editor → New query → paste this block → Run":

```sql
create table settings (
  id text primary key default 'singleton',
  qualification_rules jsonb not null default '{"requireNoWebsite": true, "requirePhone": true}'::jsonb,
  custom_terms text[] not null default array[]::text[]
);
insert into settings (id) values ('singleton');

alter table leads add column qualified_override boolean;
```

**Step 2: Verify with Igor**

Igor opens Table Editor → confirms:
- `settings` table exists with one row (`id = 'singleton'`)
- `leads` table now has a `qualified_override` column (last column)

Reply needed: "schema done" before proceeding.

**No commit** (schema lives in Supabase, not in repo).

---

## Phase 1 — Types + pure rule logic

### Task 1: Add types to `lib/types.ts`

**Files:**
- Modify: `lib/types.ts`

**Step 1: Apply patch**

Inside the existing `Lead` interface, add right after `qualified: boolean;`:

```ts
  qualified_override: boolean | null;
```

At the end of the file, add:

```ts
export interface QualificationRule {
  requireNoWebsite: boolean;
  requirePhone: boolean;
  minGoogleRating: number | null;
  minReviewCount: number | null;
  requireInstagram: boolean;
  requireActiveInstagram: boolean;
  minInstagramFollowers: number | null;
  allowedCities: string[] | null;
}

export const DEFAULT_RULE: QualificationRule = {
  requireNoWebsite: true,
  requirePhone: true,
  minGoogleRating: null,
  minReviewCount: null,
  requireInstagram: false,
  requireActiveInstagram: false,
  minInstagramFollowers: null,
  allowedCities: null,
};

export interface Settings {
  rule: QualificationRule;
  customTerms: string[];
}
```

**Step 2: Verify**

Run: `cd /Users/chartfumonkey/Code/fit-leads-hr && npx tsc --noEmit`
Expected: zero errors.

**No commit yet** — bundle with Task 2.

---

### Task 2: Create `lib/qualification.ts`

**Files:**
- Create: `lib/qualification.ts`

**Step 1: Write the file**

```ts
import type { Lead, QualificationRule } from "@/lib/types";

/**
 * Subset of Lead fields that the rule reads. Used by the recompute endpoint
 * to keep its SELECT narrow (less data over the wire).
 */
export type LeadForRule = Pick<
  Lead,
  | "has_real_website"
  | "phone"
  | "google_rating"
  | "google_review_count"
  | "instagram_handle"
  | "instagram_is_active"
  | "instagram_followers"
  | "city"
>;

/**
 * Pure function — given a lead's fields and a rule, returns whether the lead
 * is qualified per the rule. Same logic shared by /api/scrape (new rows) and
 * /api/settings/recompute-qualified (existing rows).
 *
 * AND logic across all enabled criteria. Disabled criteria pass through.
 */
export function computeQualified(lead: LeadForRule, rule: QualificationRule): boolean {
  if (rule.requireNoWebsite && lead.has_real_website) return false;
  if (rule.requirePhone && !(lead.phone && lead.phone.trim().length > 0)) return false;
  if (rule.minGoogleRating !== null && (lead.google_rating ?? -1) < rule.minGoogleRating) return false;
  if (rule.minReviewCount !== null && (lead.google_review_count ?? -1) < rule.minReviewCount) return false;
  if (rule.requireInstagram && !lead.instagram_handle) return false;
  if (rule.requireActiveInstagram && lead.instagram_is_active !== true) return false;
  if (rule.minInstagramFollowers !== null && (lead.instagram_followers ?? -1) < rule.minInstagramFollowers) return false;
  if (rule.allowedCities !== null && rule.allowedCities.length > 0) {
    if (!lead.city || !rule.allowedCities.includes(lead.city)) return false;
  }
  return true;
}
```

**Step 2: Verify**

Run: `cd /Users/chartfumonkey/Code/fit-leads-hr && npx tsc --noEmit`
Expected: zero errors.

**Step 3: Commit Phase 1**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add lib/types.ts lib/qualification.ts
git commit -m "feat(qualification): types + pure computeQualified() helper"
```

---

## Phase 2 — Settings API

### Task 3: `GET` and `PATCH /api/settings`

**Files:**
- Create: `app/api/settings/route.ts`

**Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEFAULT_RULE, type QualificationRule, type Settings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → current settings
export async function GET() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("settings")
    .select("qualification_rules, custom_terms")
    .eq("id", "singleton")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Settings row missing" }, { status: 500 });

  const rule = { ...DEFAULT_RULE, ...((data.qualification_rules as Partial<QualificationRule>) ?? {}) };
  const settings: Settings = { rule, customTerms: (data.custom_terms as string[]) ?? [] };
  return NextResponse.json(settings);
}

// PATCH → partial update of rule and/or customTerms
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};

  if (body.rule && typeof body.rule === "object") {
    // Read existing then merge to preserve any field the client doesn't send.
    const supabase = getServerSupabase();
    const { data } = await supabase
      .from("settings")
      .select("qualification_rules")
      .eq("id", "singleton")
      .maybeSingle();
    const existing = (data?.qualification_rules as Partial<QualificationRule>) ?? {};
    patch.qualification_rules = { ...DEFAULT_RULE, ...existing, ...(body.rule as Partial<QualificationRule>) };
  }
  if (Array.isArray(body.customTerms)) {
    patch.custom_terms = (body.customTerms as unknown[])
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t) => t.trim());
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no recognised fields to update" }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const { error } = await supabase.from("settings").update(patch).eq("id", "singleton");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Return the full new state so caller can update its UI.
  return GET();
}
```

**Step 2: Verify**

```bash
curl -s http://localhost:3000/api/settings | head -c 500
```
Expected: JSON with `rule` (defaults: `requireNoWebsite: true`, `requirePhone: true`, others null/false) and `customTerms: []`.

```bash
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"customTerms":["yoga studio","pilates"]}' http://localhost:3000/api/settings
```
Expected: same response, `customTerms` now `["yoga studio", "pilates"]`.

**Step 3: Commit**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add app/api/settings/route.ts
git commit -m "feat(api): GET + PATCH /api/settings (rule + custom terms)"
```

---

### Task 4: `POST /api/settings/recompute-qualified`

**Files:**
- Create: `app/api/settings/recompute-qualified/route.ts`

**Step 1: Write the route**

```ts
import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { computeQualified, type LeadForRule } from "@/lib/qualification";
import { DEFAULT_RULE, type QualificationRule } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Re-runs qualification across all leads where qualified_override IS NULL.
// Two batched UPDATEs (one per outcome) so we don't issue N round-trips.
export async function POST() {
  const supabase = getServerSupabase();

  const { data: settingsRow, error: settingsErr } = await supabase
    .from("settings")
    .select("qualification_rules")
    .eq("id", "singleton")
    .maybeSingle();
  if (settingsErr) return NextResponse.json({ error: settingsErr.message }, { status: 500 });

  const rule: QualificationRule = {
    ...DEFAULT_RULE,
    ...((settingsRow?.qualification_rules as Partial<QualificationRule>) ?? {}),
  };

  const { data: leads, error: leadsErr } = await supabase
    .from("leads")
    .select("id, has_real_website, phone, google_rating, google_review_count, instagram_handle, instagram_is_active, instagram_followers, city")
    .is("qualified_override", null);
  if (leadsErr) return NextResponse.json({ error: leadsErr.message }, { status: 500 });

  const trueIds: string[] = [];
  const falseIds: string[] = [];
  for (const lead of leads ?? []) {
    const isQualified = computeQualified(lead as LeadForRule, rule);
    (isQualified ? trueIds : falseIds).push(lead.id as string);
  }

  if (trueIds.length) {
    const { error } = await supabase.from("leads").update({ qualified: true }).in("id", trueIds);
    if (error) return NextResponse.json({ error: `update true: ${error.message}` }, { status: 500 });
  }
  if (falseIds.length) {
    const { error } = await supabase.from("leads").update({ qualified: false }).in("id", falseIds);
    if (error) return NextResponse.json({ error: `update false: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    updated: (trueIds.length + falseIds.length),
    qualified: trueIds.length,
    unqualified: falseIds.length,
  });
}
```

**Step 2: Verify**

```bash
curl -s -X POST http://localhost:3000/api/settings/recompute-qualified
```
Expected: `{"updated": N, "qualified": K, "unqualified": L}` where N is total leads with `qualified_override IS NULL` (likely all of them right now).

Then in Supabase Table Editor or via:
```bash
curl -s http://localhost:3000/api/leads?qualified=false | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d))"
```
Expected: count matches `unqualified` from the recompute response.

**Step 3: Commit**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add app/api/settings/recompute-qualified/route.ts
git commit -m "feat(api): POST /api/settings/recompute-qualified"
```

---

## Phase 3 — Wire qualification into existing endpoints

### Task 5: `/api/scrape` reads rule from settings

**Files:**
- Modify: `app/api/scrape/route.ts`

**Step 1: Patch**

Add at the top of the file (after existing imports):
```ts
import { computeQualified } from "@/lib/qualification";
import { DEFAULT_RULE, type QualificationRule } from "@/lib/types";
```

Inside the `start(controller)` function, AFTER the `getServerSupabase()` call but BEFORE the "Skip existing" block, add:

```ts
        // ---- 2.5 Read the qualification rule (one query, used to mark each new row) ----
        const { data: settingsRow } = await supabase
          .from("settings")
          .select("qualification_rules")
          .eq("id", "singleton")
          .maybeSingle();
        const rule: QualificationRule = {
          ...DEFAULT_RULE,
          ...((settingsRow?.qualification_rules as Partial<QualificationRule>) ?? {}),
        };
```

Then in the "Build rows + upsert" section, change the `rows = candidates.map(...)` block — replace this line:
```ts
          qualified: !websiteResults[i] && !!p.phone,
```
with:
```ts
          qualified: computeQualified(
            {
              has_real_website: websiteResults[i],
              phone: p.phone,
              google_rating: p.google_rating,
              google_review_count: p.google_review_count,
              instagram_handle: null,           // not yet enriched at this point
              instagram_is_active: null,
              instagram_followers: null,
              city,
            },
            rule,
          ),
```

**Step 2: Verify**

```bash
curl -N -s -X POST -H 'Content-Type: application/json' -d '{"city":"Čakovec","term":"fitness coach","skipExisting":false}' http://localhost:3000/api/scrape | head -10
```
Expected: same SSE flow as before, ending in `done` event with similar counts (the rule is the default — just no-website + has-phone — so qualified count should be unchanged from previous behavior).

**Step 3: Commit**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add app/api/scrape/route.ts
git commit -m "feat(scrape): apply user-configured rule when computing qualified"
```

---

### Task 6: `PATCH /api/leads/[id]` accepts `qualified_override`

**Files:**
- Modify: `app/api/leads/[id]/route.ts`

**Step 1: Patch**

Add to the imports:
```ts
import { computeQualified } from "@/lib/qualification";
import { DEFAULT_RULE, type QualificationRule } from "@/lib/types";
```

In the PATCH handler, after the existing field-extract block (status/notes/priority), add:

```ts
  // qualified_override: null | true | false — three-state manual override
  let overrideToSet: boolean | null | undefined = undefined;
  if (body.qualified_override === null || body.qualified_override === true || body.qualified_override === false) {
    overrideToSet = body.qualified_override;
  }
```

Replace the existing "no editable fields supplied" check with:
```ts
  if (Object.keys(patch).length === 0 && overrideToSet === undefined) {
    return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
  }
```

After the existing `.update(patch)` call (which returns `data`), add the override + recompute logic. Replace the entire existing UPDATE block with:

```ts
  const supabase = getServerSupabase();

  // First update the regular CRM fields (if any)
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Then handle qualified_override + derived qualified
  if (overrideToSet !== undefined) {
    if (overrideToSet === null) {
      // Clear the override → recompute qualified for THIS row from current rule
      const { data: row } = await supabase
        .from("leads")
        .select("has_real_website, phone, google_rating, google_review_count, instagram_handle, instagram_is_active, instagram_followers, city")
        .eq("id", id)
        .maybeSingle();
      if (!row) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

      const { data: settingsRow } = await supabase
        .from("settings")
        .select("qualification_rules")
        .eq("id", "singleton")
        .maybeSingle();
      const rule: QualificationRule = {
        ...DEFAULT_RULE,
        ...((settingsRow?.qualification_rules as Partial<QualificationRule>) ?? {}),
      };
      const recomputedQualified = computeQualified(row, rule);

      const { error } = await supabase
        .from("leads")
        .update({ qualified_override: null, qualified: recomputedQualified })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      // Force qualified to match the override
      const { error } = await supabase
        .from("leads")
        .update({ qualified_override: overrideToSet, qualified: overrideToSet })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // Return the latest row state
  const { data: latest, error: readErr } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!latest) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  return NextResponse.json(latest as Lead);
```

(Remove the old `.update(patch).eq(...).select().maybeSingle()` block since we replaced it.)

**Step 2: Verify**

Pick an existing lead id (any one from `/leads` URL).

Force qualified true:
```bash
LEAD_ID=<some-id>
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"qualified_override":true}' http://localhost:3000/api/leads/$LEAD_ID | python3 -c "import sys,json;d=json.load(sys.stdin);print('qualified:',d['qualified'],'override:',d['qualified_override'])"
```
Expected: `qualified: True override: True`

Force qualified false:
```bash
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"qualified_override":false}' http://localhost:3000/api/leads/$LEAD_ID | python3 -c "import sys,json;d=json.load(sys.stdin);print('qualified:',d['qualified'],'override:',d['qualified_override'])"
```
Expected: `qualified: False override: False`

Clear override (back to rule):
```bash
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"qualified_override":null}' http://localhost:3000/api/leads/$LEAD_ID | python3 -c "import sys,json;d=json.load(sys.stdin);print('qualified:',d['qualified'],'override:',d['qualified_override'])"
```
Expected: `override: None`, `qualified` is whatever the rule says (likely `True` if it's a no-website-with-phone lead).

**Step 3: Commit**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add app/api/leads/'[id]'/route.ts
git commit -m "feat(api): PATCH /api/leads/[id] accepts qualified_override (3-state)"
```

---

## Phase 4 — Settings page UI

### Task 7: `components/custom-terms-manager.tsx`

**Files:**
- Create: `components/custom-terms-manager.tsx`

**Step 1: Write**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  initialTerms: string[];
}

export function CustomTermsManager({ initialTerms }: Props) {
  const router = useRouter();
  const [terms, setTerms] = useState(initialTerms);
  const [draft, setDraft] = useState("");
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function save(next: string[]) {
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
    const next = [...terms, t];
    setTerms(next);
    setDraft("");
    startTransition(async () => {
      const ok = await save(next);
      if (ok) router.refresh();
      else setTerms(terms); // rollback
    });
  }

  function removeTerm(t: string) {
    const next = terms.filter((x) => x !== t);
    setTerms(next);
    startTransition(async () => {
      const ok = await save(next);
      if (ok) router.refresh();
      else setTerms(terms); // rollback
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
```

**Step 2: Verify**

Skip — will exercise via the page in Task 9.

---

### Task 8: `components/settings-form.tsx` (qualification rule UI)

**Files:**
- Create: `components/settings-form.tsx`

**Step 1: Write**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { QualificationRule } from "@/lib/types";

interface Props {
  initialRule: QualificationRule;
  initialQualifiedCount: number;
  cities: string[]; // distinct cities present in DB
}

export function SettingsForm({ initialRule, initialQualifiedCount, cities }: Props) {
  const router = useRouter();
  const [rule, setRule] = useState<QualificationRule>(initialRule);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function commit(next: QualificationRule) {
    setRule(next);
    startTransition(async () => {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: next }),
      });
      if (res.ok) {
        setSavedAt(Date.now());
        router.refresh();
      }
    });
  }

  async function recompute() {
    setRecomputeMsg("Recomputing…");
    const res = await fetch("/api/settings/recompute-qualified", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setRecomputeMsg(`Failed: ${body.error ?? res.status}`);
      return;
    }
    const out = await res.json();
    setRecomputeMsg(`Done. ${out.qualified} qualified, ${out.unqualified} not, of ${out.updated} reviewed.`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Always-on defaults (rendered as toggles for transparency) */}
      <Toggle
        label="Require: no real website"
        hint="Lead's listed website is null, social-only, or unreachable."
        checked={rule.requireNoWebsite}
        onChange={(v) => commit({ ...rule, requireNoWebsite: v })}
      />
      <Toggle
        label="Require: has a phone number"
        hint="Without this you can't actually call them."
        checked={rule.requirePhone}
        onChange={(v) => commit({ ...rule, requirePhone: v })}
      />

      <ThresholdToggle
        label="Min Google rating"
        hint="Filter out leads with poor or no Google reviews."
        value={rule.minGoogleRating}
        placeholder="e.g. 4.0"
        step="0.1"
        onChange={(v) => commit({ ...rule, minGoogleRating: v })}
      />
      <ThresholdToggle
        label="Min Google review count"
        hint="Drop leads that nobody has reviewed."
        value={rule.minReviewCount}
        placeholder="e.g. 5"
        step="1"
        onChange={(v) => commit({ ...rule, minReviewCount: v })}
      />

      <Toggle
        label="Require: has Instagram handle"
        hint="At least an IG handle present (set by enrichment or scraped from website)."
        checked={rule.requireInstagram}
        onChange={(v) => commit({ ...rule, requireInstagram: v })}
      />
      <Toggle
        label="Require: active on Instagram (last 30 days)"
        hint="Posted something recently — proxy for 'still in business'."
        checked={rule.requireActiveInstagram}
        onChange={(v) => commit({ ...rule, requireActiveInstagram: v })}
      />
      <ThresholdToggle
        label="Min Instagram followers"
        hint="Skip dormant or fake-looking accounts."
        value={rule.minInstagramFollowers}
        placeholder="e.g. 500"
        step="1"
        onChange={(v) => commit({ ...rule, minInstagramFollowers: v })}
      />

      <CityRestriction
        cities={cities}
        value={rule.allowedCities}
        onChange={(v) => commit({ ...rule, allowedCities: v })}
      />

      <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4">
        <Button onClick={recompute} variant="default">
          Recompute qualified for all {initialQualifiedCount}+ leads
        </Button>
        {savedAt ? (
          <span className="text-xs text-muted-foreground">
            Auto-saved {Math.max(0, Math.floor((Date.now() - savedAt) / 1000))}s ago
          </span>
        ) : null}
        {recomputeMsg ? (
          <span className="text-xs text-muted-foreground">{recomputeMsg}</span>
        ) : null}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function ThresholdToggle({
  label,
  hint,
  value,
  placeholder,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  placeholder: string;
  step: string;
  onChange: (v: number | null) => void;
}) {
  const enabled = value !== null;
  const [draft, setDraft] = useState(value?.toString() ?? "");

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-2">
        {enabled ? (
          <Input
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const n = Number(draft);
              if (Number.isFinite(n) && n >= 0) onChange(n);
            }}
            placeholder={placeholder}
            step={step}
            className="h-8 w-24"
          />
        ) : null}
        <Switch
          checked={enabled}
          onCheckedChange={(v) => {
            if (v) {
              const n = Number(draft);
              onChange(Number.isFinite(n) && n >= 0 ? n : 0);
            } else {
              onChange(null);
            }
          }}
        />
      </div>
    </div>
  );
}

function CityRestriction({
  cities,
  value,
  onChange,
}: {
  cities: string[];
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const enabled = value !== null;
  const selected = new Set(value ?? []);

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <Label className="text-sm">Restrict to specific cities</Label>
        <p className="text-xs text-muted-foreground">
          Tick the cities you want to focus on. Untick everything to disable the restriction.
        </p>
        {enabled ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {cities.map((c) => {
              const on = selected.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    const next = new Set(selected);
                    if (on) next.delete(c);
                    else next.add(c);
                    onChange(Array.from(next));
                  }}
                  className={
                    "rounded-md border px-2 py-1 text-xs " +
                    (on
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:text-foreground")
                  }
                >
                  {c}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={(v) => onChange(v ? [] : null)}
      />
    </div>
  );
}
```

**Step 2: Verify**

Skip — exercised via page in Task 9.

---

### Task 9: `app/settings/page.tsx`

**Files:**
- Create: `app/settings/page.tsx`

**Step 1: Write**

```tsx
import { getServerSupabase } from "@/lib/supabase-server";
import { DEFAULT_RULE, type QualificationRule } from "@/lib/types";
import { SettingsForm } from "@/components/settings-form";
import { CustomTermsManager } from "@/components/custom-terms-manager";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = getServerSupabase();

  const [settingsRes, citiesRes, countRes] = await Promise.all([
    supabase
      .from("settings")
      .select("qualification_rules, custom_terms")
      .eq("id", "singleton")
      .maybeSingle(),
    supabase.from("leads").select("city").not("city", "is", null),
    supabase.from("leads").select("id", { count: "exact", head: true }).is("qualified_override", null),
  ]);

  const rule: QualificationRule = {
    ...DEFAULT_RULE,
    ...((settingsRes.data?.qualification_rules as Partial<QualificationRule>) ?? {}),
  };
  const customTerms = (settingsRes.data?.custom_terms as string[]) ?? [];
  const cities = Array.from(
    new Set(((citiesRes.data ?? []) as { city: string }[]).map((r) => r.city)),
  ).sort((a, b) => a.localeCompare(b, "hr"));
  const ruleEligibleCount = countRes.count ?? 0;

  return (
    <main className="mx-auto max-w-screen-md space-y-8 p-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tune the qualification rule and manage your custom search terms. Changes
          auto-save. Recompute applies the rule to existing leads (skipping any with
          a manual override).
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Qualification rule</h2>
        <SettingsForm initialRule={rule} initialQualifiedCount={ruleEligibleCount} cities={cities} />
      </section>

      <section className="space-y-3 border-t border-border pt-6">
        <h2 className="text-sm font-medium text-muted-foreground">Custom search terms</h2>
        <p className="text-xs text-muted-foreground">
          Added here, these appear as additional checkboxes alongside the 6 defaults on{" "}
          <code>/scrape</code>.
        </p>
        <CustomTermsManager initialTerms={customTerms} />
      </section>
    </main>
  );
}
```

**Step 2: Add nav link in `app/layout.tsx`**

In the `<nav>` block, after the existing Scrape link, add:
```tsx
          <Link href="/settings" className="text-muted-foreground hover:text-foreground">
            Settings
          </Link>
```

**Step 3: Verify**

```bash
curl -s -o /dev/null -w "settings page: %{http_code}\n" http://localhost:3000/settings
```
Expected: 200.

In browser:
- Visit http://localhost:3000/settings
- Toggle "Min Google rating" on, type `4.0`, click outside the input → "Auto-saved Xs ago" appears
- Toggle "Restrict to specific cities" on → city pills appear → click a few
- Click "Recompute…" → status text updates with counts
- Add a custom term → appears as a chip
- Refresh page → all changes persisted

**Step 4: Commit**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add app/settings/page.tsx app/layout.tsx components/settings-form.tsx components/custom-terms-manager.tsx
git commit -m "feat(settings): /settings page with rule editor + custom terms manager"
```

---

## Phase 5 — Manual override UI on /leads

### Task 10: `components/qualified-toggle.tsx`

**Files:**
- Create: `components/qualified-toggle.tsx`

**Step 1: Write**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface Props {
  leadId: string;
  qualified: boolean;            // current effective state
  qualifiedOverride: boolean | null;
  className?: string;
}

/**
 * 3-state cycle button:
 *   override = null  → indicator shows the rule's verdict (✓ or ✗) in muted color
 *   override = true  → ✓ in solid yellow (manual yes)
 *   override = false → ✗ in solid red (manual no)
 *
 * Click cycles: null → true → false → null.
 */
export function QualifiedToggle({ leadId, qualified, qualifiedOverride, className }: Props) {
  const router = useRouter();
  const [override, setOverride] = useState<boolean | null>(qualifiedOverride);
  const [effective, setEffective] = useState(qualified);
  const [, startTransition] = useTransition();

  function next(): boolean | null {
    if (override === null) return true;
    if (override === true) return false;
    return null;
  }

  function click() {
    const target = next();
    setOverride(target);
    if (target !== null) setEffective(target);
    // optimistic; effective for null gets reconciled on router.refresh()
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
      ? "Forced qualified — click to force unqualified"
      : override === false
        ? "Forced unqualified — click to clear override"
        : effective
          ? "Rule says qualified — click to force qualified"
          : "Rule says unqualified — click to force qualified";

  const display =
    override === true
      ? { text: "✓", style: "bg-yellow-400 text-black border-yellow-400" }
      : override === false
        ? { text: "✗", style: "bg-destructive text-destructive-foreground border-destructive" }
        : effective
          ? { text: "✓", style: "border-border text-muted-foreground" }
          : { text: "✗", style: "border-border text-muted-foreground" };

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
```

**Step 2: Verify**

Skip — exercised via Tasks 11/12.

---

### Task 11: Wire `<QualifiedToggle>` into `/leads` table

**Files:**
- Modify: `components/leads-table.tsx`

**Step 1: Patch**

Add to the existing imports:
```tsx
import { QualifiedToggle } from "@/components/qualified-toggle";
```

In the `LeadRow` component's JSX, add a new `<TableCell>` immediately AFTER the row checkbox cell and BEFORE the name cell:
```tsx
      <TableCell>
        <QualifiedToggle
          leadId={lead.id}
          qualified={lead.qualified}
          qualifiedOverride={lead.qualified_override}
        />
      </TableCell>
```

In the `<TableHeader>` row, add a corresponding empty header cell after the select-all checkbox:
```tsx
              <TableHead className="w-8"></TableHead>
```

**Step 2: Verify in browser**

- Visit `/leads`
- Each row should now show a small ✓/✗ icon between the row checkbox and the name
- Click an icon — color changes (yellow ✓ for forced-qualified, red ✗ for forced-unqualified, muted for rule-derived)
- Click again twice → cycles back to muted (rule-derived)
- The "qualified only" filter switch still works

**Step 3: Commit**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add components/leads-table.tsx components/qualified-toggle.tsx
git commit -m "feat(leads): 3-state qualified toggle in the table"
```

---

### Task 12: Wire `<QualifiedToggle>` into `/leads/[id]` header

**Files:**
- Modify: `app/leads/[id]/page.tsx`

**Step 1: Patch**

Add to imports:
```tsx
import { QualifiedToggle } from "@/components/qualified-toggle";
```

Replace the existing `qualified` badge in the header:
```tsx
        {lead.qualified ? (
          <Badge variant="secondary" className="bg-green-900/40 text-green-300">
            qualified
          </Badge>
        ) : null}
```
with:
```tsx
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <QualifiedToggle
            leadId={lead.id}
            qualified={lead.qualified}
            qualifiedOverride={lead.qualified_override}
          />
          {lead.qualified_override === true
            ? "forced qualified"
            : lead.qualified_override === false
              ? "forced unqualified"
              : lead.qualified
                ? "qualified (rule)"
                : "not qualified (rule)"}
        </span>
```

**Step 2: Verify in browser**

- Click into any lead from `/leads`
- Header shows toggle + label
- Click toggle → label and color update; reload → state persists

**Step 3: Commit**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add app/leads/'[id]'/page.tsx
git commit -m "feat(leads): qualified toggle in detail page header"
```

---

## Phase 6 — Custom terms in /scrape

### Task 13: Pass custom terms from server to `<ScrapeClient>`

**Files:**
- Modify: `app/scrape/page.tsx`
- Modify: `components/scrape-client.tsx`
- Modify: `components/scrape-form.tsx`

**Step 1: Patch `app/scrape/page.tsx`**

Convert to async server component that fetches settings:

```tsx
import { ScrapeClient } from "@/components/scrape-client";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function ScrapePage() {
  const supabase = getServerSupabase();
  const { data } = await supabase
    .from("settings")
    .select("custom_terms")
    .eq("id", "singleton")
    .maybeSingle();
  const customTerms = (data?.custom_terms as string[]) ?? [];

  return (
    <main className="mx-auto max-w-screen-lg space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Scrape</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulls fitness coaches from Google Places (New) for the selected cities and
          search terms. Filters down to those qualifying under your current rule.
          Fires one request per (city × term) combo — keep this tab open.
        </p>
      </header>

      <ScrapeClient initialCustomTerms={customTerms} />
    </main>
  );
}
```

**Step 2: Patch `components/scrape-client.tsx`**

Add a prop for custom terms and pass through:

```tsx
// Add to Props (just inside the function signature):
export function ScrapeClient({ initialCustomTerms }: { initialCustomTerms: string[] }) {
```

In the JSX, change:
```tsx
      <ScrapeForm onSubmit={runScrape} running={running} />
```
to:
```tsx
      <ScrapeForm onSubmit={runScrape} running={running} customTerms={initialCustomTerms} />
```

**Step 3: Patch `components/scrape-form.tsx`**

Add the import:
```tsx
import { CustomTermsManager } from "@/components/custom-terms-manager";
```

Update the Props interface to accept `customTerms`:
```tsx
interface Props {
  onSubmit: (req: ScrapeRequest) => void;
  running: boolean;
  customTerms: string[];
}
```

In the function signature add the prop:
```tsx
export function ScrapeForm({ onSubmit, running, customTerms }: Props) {
```

Compute the full term list at the top of the component:
```tsx
  const ALL_TERMS = [...TERMS, ...customTerms];
```

In the term checkbox grid, change the map source from `TERMS` to `ALL_TERMS`.

In the Section actions for terms, change "Select all" to set the full list:
```tsx
            <BulkLink onClick={() => setSelectedTerms(new Set(ALL_TERMS))}>Select all</BulkLink>
```

Below the term grid (still inside the Section), add the inline CustomTermsManager so Igor can add new terms without leaving the page:
```tsx
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Add a custom term — saves to settings, appears here next time too.
            </p>
            <CustomTermsManager initialTerms={customTerms} />
          </div>
```

**Step 4: Verify in browser**

- Visit `/scrape`
- The 6 default terms still show as checkboxes
- If you previously added "yoga studio" / "pilates" via Settings, they show as additional checkboxes
- Below the grid: the "Add a custom term" input + chips list
- Type a new term, hit Add → it appears as a new checkbox above
- Refresh → it's still there

**Step 5: Commit**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add app/scrape/page.tsx components/scrape-client.tsx components/scrape-form.tsx
git commit -m "feat(scrape): show custom terms in form + inline add"
```

---

## Phase 7 — End-to-end verification

### Task 14: Walk Igor through the verification plan

Run through every step from the design doc's "Verification plan" section. Each numbered step is a checkpoint with Igor — pause for "looks good" before moving to the next.

1. Schema migration applied (already verified Task 0)
2. `/settings` renders with defaults
3. Toggle "Min IG followers" → 1000 → auto-save → recompute → /leads qualified count drops
4. Add "yoga studio" custom term in Settings → switch to /scrape → checkbox appears
5. Add another term inline on /scrape → /settings shows it too
6. Cycle a lead's qualified toggle on /leads → forced-yes → still qualified after recompute
7. Toggle to forced-no → drops out of "qualified only" filter
8. Toggle back to rule (null) → recomputes per rule
9. Run a small scrape (Čakovec + fitness coach) with the strict 1000-followers rule still active — expect 0 qualified, since no Čakovec coaches will hit that bar
10. Loosen the rule (turn off min followers), recompute → leads come back

If any step fails, paste exact error and stop. Don't proceed.

### Task 15: Push final changes for Vercel deploy

After Igor confirms verification:
```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git push
```

Vercel auto-rebuilds. Verify deployed version: visit /settings on the .vercel.app URL, do one rule edit + recompute to confirm cloud-side persistence works.

---

## Build verification checklist

Before each commit's `git push`, run:
```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npm run build
```
The build should complete with no type errors. If it fails, fix the type error and re-run before committing further work.

## Rollback notes

The schema migration is additive (new table, new nullable column). If something goes badly wrong:
- Set every `qualified_override` to null: `update leads set qualified_override = null;` — this restores rule-only behavior for all rows.
- Drop the settings table: `drop table settings;` — endpoints will start 500ing until recreated; revert the code.
- Drop the column: `alter table leads drop column qualified_override;` — only do this if you're sure no override data is worth keeping.
