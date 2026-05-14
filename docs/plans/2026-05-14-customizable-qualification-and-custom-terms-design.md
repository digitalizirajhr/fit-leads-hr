# Customizable Qualification + Custom Search Terms — Design

**Date:** 2026-05-14
**Status:** approved, ready for implementation plan

## Goal

Two related additions to the v1 app:

1. **Customizable qualification rule.** Today `qualified` is hard-coded as `!has_real_website && !!phone`. Igor wants to control which fields the rule looks at and what the thresholds are, plus an escape hatch to manually override the result per lead.
2. **Custom search terms.** Today `/scrape` exposes 6 fixed terms (`personal trainer`, `fitness trener`, `fitness coach`, `teretana`, `fitness studio`, `kineziolog`). Igor wants to add his own (e.g. `yoga studio`, `pilates`, `crossfit`) without editing code.

Both settings persist server-side so they survive across sessions and devices.

## Decisions made during brainstorm

- **Qualification approach:** rule + manual override (not rule-only, not manual-only).
- **Available criteria:** all of — Google quality (rating + reviews), Instagram presence (handle / active / followers), city restriction.
- **Custom terms UX:** inline on `/scrape` with a text-input + Add button. Terms persist in Supabase so they show up next session and on any device.
- **Manual override states:** 3-state per lead (rule / forced-yes / forced-no). Click cycles through.
- **Settings page UX:** auto-save on each change. Recompute is a separate explicit button.

## Data model

### New table: `settings` (singleton row)

```sql
create table settings (
  id text primary key default 'singleton',
  qualification_rules jsonb not null default '{"requireNoWebsite": true, "requirePhone": true}'::jsonb,
  custom_terms text[] not null default array[]::text[]
);

insert into settings (id) values ('singleton');
```

Pattern: one row, `id = 'singleton'`. We never insert other rows. Keeps schema trivial; avoids needing JOINs.

### New column on `leads`

```sql
alter table leads add column qualified_override boolean;
```

Three-state semantics:
- `NULL` → follow the rule (default for all existing rows; will be the default for any newly scraped row)
- `true` → force qualified, ignore rule
- `false` → force unqualified, ignore rule

The existing `qualified` column stays — it is the *effective* state used by all filter queries. It just gets computed from `qualified_override` (if set) or the rule (otherwise).

### Rule shape (TypeScript)

```ts
interface QualificationRule {
  requireNoWebsite: boolean;        // default true
  requirePhone: boolean;             // default true
  minGoogleRating: number | null;    // null = not enforced
  minReviewCount: number | null;     // null = not enforced
  requireInstagram: boolean;         // default false; must have IG handle
  requireActiveInstagram: boolean;   // default false; posted in last 30d
  minInstagramFollowers: number | null;
  allowedCities: string[] | null;    // null = no city restriction
}
```

Stored as JSONB to allow adding fields later without a migration.

## API surface

### New endpoints

- `GET /api/settings` → `{ rule: QualificationRule, customTerms: string[] }`
- `PATCH /api/settings` → partial update, returns the new full state. Used for both rule edits and term add/remove.
- `POST /api/settings/recompute-qualified` → reapplies the current rule to every row in `leads` where `qualified_override IS NULL`. Returns `{ updated: number }`.

### Modified endpoints

- `POST /api/scrape` (per-chunk endpoint) — when computing `qualified` for newly upserted rows, read the rule from `settings` and apply it. Skip the override check (new rows have `qualified_override = NULL`).
- `PATCH /api/leads/[id]` — already accepts a partial body; extend the allow-list to include `qualified_override` (one of `null | true | false`). When set, also recompute the row's `qualified` value in the same transaction.

## Recompute algorithm

```ts
async function recomputeQualified(rule: QualificationRule, supabase): Promise<{ updated: number }> {
  // Pull only rows that follow the rule (override IS NULL).
  const { data: leads } = await supabase
    .from("leads")
    .select("id, has_real_website, phone, google_rating, google_review_count, instagram_handle, instagram_is_active, instagram_followers, city")
    .is("qualified_override", null);

  const trueIds: string[] = [];
  const falseIds: string[] = [];
  for (const lead of leads) {
    (computeQualified(lead, rule) ? trueIds : falseIds).push(lead.id);
  }

  // Two batched UPDATEs — one per outcome — instead of N individual updates.
  if (trueIds.length)  await supabase.from("leads").update({ qualified: true  }).in("id", trueIds);
  if (falseIds.length) await supabase.from("leads").update({ qualified: false }).in("id", falseIds);

  return { updated: leads.length };
}
```

`computeQualified` lives in a new shared `lib/qualification.ts` so the scrape endpoint and the recompute endpoint produce identical results.

## UI

### New `/settings` page

Top nav: add a third link `Settings` next to `Leads` / `Scrape`.

Two sections:

**Qualification rule** — for each criterion, a `<Switch />` to enable/disable. For threshold criteria (rating, reviews, followers), an additional number input that's enabled only when the switch is on. For city restriction, a multi-select populated from `distinct city` in `leads`. Each control auto-saves on change via `PATCH /api/settings`.

Below: `<Button>Recompute qualified for all N leads</Button>` where N = `count(*)` from leads excluding overrides. Click → `POST /api/settings/recompute-qualified` → toast / inline confirmation with the count updated. Disabled while running.

**Custom search terms** — list of current terms with `×` delete buttons. Below: `<Input placeholder="Add term..." /> + <Button>Add</Button>`. Each add/remove auto-saves.

### `/scrape` page changes

The term checkbox grid is now built from `[...DEFAULT_TERMS, ...customTerms]`. Same UX as before. Server fetches `customTerms` via `GET /api/settings` server-side, passes to the client component as initial props.

Below the term grid: a small `+ Add term` row (mirrors the Settings management — quick add without leaving the page). Calls the same PATCH endpoint and refreshes via `router.refresh()` so the new checkbox appears immediately.

### `/leads` table changes

Add a single qualified-state cell to each row (could be a small icon button in an existing column or a new narrow column — implementation detail). Three states with a visible distinction (e.g. checkmark / x / lock icon for overridden). Click to cycle: `null → true → false → null`. Updates fire `PATCH /api/leads/[id]` with `{ qualified_override: <next> }` and `router.refresh()`.

The existing "Qualified only" filter switch in the top bar is unchanged — it still filters on the `qualified` column, which is now the effective (override-or-rule) state.

### `/leads/[id]` detail page

The "qualified" badge in the header becomes a clickable button cycling through the same 3 states. Visual style indicates whether the current state came from the rule or a manual override.

## Files affected

**New:**
- `app/settings/page.tsx`
- `app/api/settings/route.ts`
- `app/api/settings/recompute-qualified/route.ts`
- `components/settings-form.tsx` — qualification rule UI
- `components/custom-terms-manager.tsx` — reusable terms editor (used by both Settings and Scrape)
- `components/qualified-toggle.tsx` — 3-state toggle reused in table + detail header
- `lib/qualification.ts` — `computeQualified(lead, rule): boolean`

**Modified:**
- `lib/types.ts` — add `QualificationRule`, `Settings`, `qualified_override` field on `Lead`
- `app/api/scrape/route.ts` — read rule from settings, use `computeQualified`
- `app/api/leads/[id]/route.ts` — accept `qualified_override` in PATCH; recompute `qualified` based on it
- `components/leads-table.tsx` — add `<QualifiedToggle>` column
- `app/leads/[id]/page.tsx` — replace static qualified badge with `<QualifiedToggle>`
- `components/scrape-form.tsx` — fetch & display custom terms; inline add input
- `app/scrape/page.tsx` — fetch settings server-side, pass to ScrapeClient
- `app/layout.tsx` — Settings nav link

**SQL migration Igor runs (one block):**
```sql
create table settings (
  id text primary key default 'singleton',
  qualification_rules jsonb not null default '{"requireNoWebsite": true, "requirePhone": true}'::jsonb,
  custom_terms text[] not null default array[]::text[]
);
insert into settings (id) values ('singleton');

alter table leads add column qualified_override boolean;
```

## Out of scope (YAGNI)

- Multiple named rule presets ("cold call rule" vs "DM rule"). Single global rule is enough.
- Boolean OR logic between criteria. AND across all enabled criteria.
- Audit log of rule changes / who flipped which override.
- Retroactive recompute on rule change is manual (button) not automatic — auto-recompute on every keystroke would be wasteful.

## Verification plan

End-to-end check after implementation:

1. Run the new SQL block in Supabase → confirm `settings` table exists with one row, `qualified_override` column exists on `leads`.
2. Visit `/settings` → form renders with current defaults (no-website + has-phone on, others off / null).
3. Toggle "Min IG followers" on, set to 1000, wait for auto-save → confirm value persists on reload.
4. Click "Recompute qualified for all N leads" → number of qualified leads in `/leads` should drop (since most leads don't have 1000+ IG followers).
5. Add custom term `yoga studio` in Settings → switch to `/scrape` → it appears as a new checkbox.
6. Add another term inline on `/scrape` → it appears in `/settings` too.
7. On `/leads`, click the qualified-state toggle on an unqualified lead → it cycles to forced-yes; lead now appears in qualified-only filter even though rule disqualifies it.
8. Recompute → forced-yes lead stays qualified (override is honored).
9. Click toggle again → forced-no; lead disappears from qualified-only filter.
10. Click toggle again → back to rule (null override), recomputes per the rule.
11. Run a scrape with a custom term — newly upserted rows respect the current rule.
