# Move qualification rule onto /scrape — Design

**Date:** 2026-05-14
**Status:** approved (Igor: "Just move the controls to /scrape, kill /settings")
**Supersedes parts of:** `2026-05-14-customizable-qualification-and-custom-terms-design.md`

## Why

The /settings page added 24 hours ago feels too far away from the scrape action. Igor wants to choose qualification criteria fresh each time he scrapes ("oneshot per scrape"), without saving anything between runs.

## What changes

- The 8 rule controls move inline into the /scrape form, between the search-term grid and the toggles.
- Each scrape POSTs its rule in the request body. `/api/scrape` reads it from the body, no longer from the `settings` row.
- `/settings` page deleted. `Settings` nav link removed.
- `POST /api/settings/recompute-qualified` deleted (no UI calls it anymore).
- `settings` table keeps `custom_terms` only — the `qualification_rules` JSONB column stays as a harmless leftover (no migration; YAGNI). `PATCH /api/settings` ignores any `rule` field going forward.
- `PATCH /api/leads/[id]` with `qualified_override: null` (clearing an override) now recomputes against `DEFAULT_RULE` rather than the previously-stored global rule. There is no longer a global rule to consult.

## What stays the same

- `lib/qualification.ts` `computeQualified()` — same pure function, called from /api/scrape with the per-request rule and from PATCH leads/[id] with DEFAULT_RULE.
- Per-lead `qualified_override` (3-state). The QualifiedToggle on /leads + detail page is unchanged.
- The "qualified only" filter switch on /leads — still filters on the `qualified` column.
- Custom search terms — still managed inline on /scrape (CustomTermsManager unchanged).

## Trade-offs Igor accepted

- Form state lost on page reload. (No URL persistence in this round; can add later if it bites.)
- No "default rule preset". Every visit starts from `DEFAULT_RULE` defaults.
- Existing leads keep whatever `qualified` value their last scrape set. To re-evaluate, scrape again with `skipExisting=off`.

## File-level impact

**Create:**
- `components/qualification-rule-form.tsx` — the 8 controls extracted as a parent-controlled (no internal state) component reused inside ScrapeForm.

**Modify:**
- `components/scrape-form.tsx` — adds `rule` + `onRuleChange` props; renders `<QualificationRuleForm/>`. Default rule = `DEFAULT_RULE`.
- `components/scrape-client.tsx` — owns the rule state; passes rule into the per-chunk POST body.
- `app/scrape/page.tsx` — drops the global-rule fetch (still fetches `customTerms`).
- `app/api/scrape/route.ts` — reads `rule` from request body, drops the settings DB read.
- `app/api/settings/route.ts` — PATCH no longer accepts/stores `rule` field.
- `app/api/leads/[id]/route.ts` — PATCH override-clear path uses `DEFAULT_RULE` directly, no settings lookup.
- `app/layout.tsx` — drop `Settings` nav link.

**Delete:**
- `app/settings/page.tsx`
- `components/settings-form.tsx`
- `app/api/settings/recompute-qualified/route.ts`

## Verification plan

1. Visit /scrape — qualification section appears between term grid and toggles, defaults to no-website + has-phone.
2. Toggle min Google rating on, set 4.0, run a tiny scrape (Čakovec + fitness coach + skipExisting=off) → fewer rows qualify than before.
3. Reload /scrape — qualification section back to defaults (state lost — expected).
4. Visit /settings → 404 (page deleted).
5. /leads QualifiedToggle still cycles 3 states; clicking back to null reverts the lead's qualified to DEFAULT_RULE's verdict.
6. Production build clean. Push. Vercel rebuild succeeds.
