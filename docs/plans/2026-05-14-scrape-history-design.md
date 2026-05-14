# Scrape History — Design

**Date:** 2026-05-14
**Status:** approved (Igor: "build it")

## Goal

Persist a record of every scrape run so Igor can later look back, see what each run produced (params, counts, the actual leads), and use that as a CRM-style audit trail / lead-source attribution.

## Data model

Two new tables. Igor runs one SQL block in Supabase.

```sql
create table scrape_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  source text not null check (source in ('google', 'instagram')),
  -- the form values for this run (cities/terms for Google, methods/values for IG, plus rule + skipExisting)
  params jsonb not null default '{}',
  -- aggregated across all chunks: { found, qualified, new, skipped }
  counts jsonb not null default '{}',
  status text not null default 'running' check (status in ('running','done','error')),
  error_message text
);

-- M:N: one run can produce many leads, one lead can be touched by many runs
create table scrape_run_leads (
  run_id uuid not null references scrape_runs(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  primary key (run_id, lead_id)
);

create index on scrape_run_leads(run_id);
create index on scrape_run_leads(lead_id);
```

## Run lifecycle (orchestrated by the client)

The chunked architecture means each (city × term) or (method × values) is its own HTTP call. A run is the OUTER loop in `scrape-client.tsx`, so the client owns the lifecycle:

```
runGoogleScrape (or runInstagramScrape):
  1. POST /api/scrape-runs { source, params }          → returns { id }
  2. for each chunk:
       POST /api/scrape (or /discover-ig) with { …, runId }
       → chunk inserts scrape_run_leads rows for everything it upserts
  3. POST /api/scrape-runs/:id/finalize { counts, status, error_message? }
       → sets ended_at + final counts + status
```

A run abandoned mid-flight (browser closed) stays at `status='running'` — a small rough edge that we don't address in v1. If it becomes annoying, a janitor could mark anything `running` for >5 min as `error`. YAGNI for now.

## API

**New endpoints:**

- `POST /api/scrape-runs` — body: `{ source, params }` → returns `{ id }`. Auth-gated.
- `POST /api/scrape-runs/:id/finalize` — body: `{ counts, status, error_message? }` → 204 on success.
- `GET /api/scrape-runs` — returns array of runs, ordered `started_at desc`. Includes counts so the table can render without N+1.
- `GET /api/scrape-runs/:id` — returns `{ run, leads }` where `leads` is a `Lead[]` joined via `scrape_run_leads`.

**Modified endpoints:**

- `POST /api/scrape` (Google chunk) — accepts optional `runId` in body. After successful upsert, also inserts `(runId, leadId)` pairs into `scrape_run_leads` (best effort — failure here is logged but doesn't fail the chunk).
- `POST /api/scrape/discover-ig` (IG chunk) — same treatment.

## UI

**New top-nav item: `History`**, between Leads and Scrape.

**`/history` page** (server component):
- Reverse-chronological table of past runs
- Columns: When (relative + tooltip with absolute) · Source (Google / Instagram badge) · Params summary (e.g. "Zagreb, Split × 3 terms" or "seed: vilimpuclin") · Found / Qualified / New / Skipped (from counts) · Status (✓ / ⚠️) · "View" link to detail
- Reuses the existing `formatRelativeTime` from `lib/format.ts`

**`/history/[id]` page** (server component):
- Header: source, started_at, ended_at, full params (pretty-printed JSON in a small mono-font block), counts, status (+ error_message if any)
- Section: **Leads from this run** — embeds the existing `<LeadsTable>` component, populated with only the leads linked to this run via `scrape_run_leads`. Inline edits (status, priority, qualified-toggle) keep working — no new code there.
- "← All runs" back link

## Files

**New:**
- `app/api/scrape-runs/route.ts` — POST (create) + GET (list)
- `app/api/scrape-runs/[id]/route.ts` — GET (details + leads)
- `app/api/scrape-runs/[id]/finalize/route.ts` — POST (finalize)
- `app/history/page.tsx` — list page
- `app/history/[id]/page.tsx` — detail page
- `lib/scrape-runs.ts` — small helpers (createRun, finalizeRun, linkLeads), shared by the chunk endpoints
- `lib/types.ts` — extend with `ScrapeRun`, `ScrapeRunWithLeads`

**Modified:**
- `app/api/scrape/route.ts` — accept + persist `runId`
- `app/api/scrape/discover-ig/route.ts` — same
- `components/scrape-client.tsx` — wraps runGoogleScrape / runInstagramScrape with create-run / finalize-run calls; passes runId to each chunk
- `app/layout.tsx` — `History` nav link

## Trade-offs / out of scope

- No live "running" dashboard (in-flight runs not visible in /history list — we only show after finalize)
- No re-run button (cool but adds form-rehydration complexity)
- No retention/deletion (table grows indefinitely; not a problem at Igor's scale for years)
- No diff view (you can compute "new vs existing" from counts.new vs counts.found, but no per-lead first-discovered-here marker)
- No filter on `/leads` by run-id (could be done later via URL param)

## Verification

1. New SQL block runs in Supabase → both tables exist
2. Run a small Google scrape (Čakovec + 1 term) → after completion, /history shows it as the top row with correct counts
3. Click into the run → detail page shows the leads it produced
4. Run a small IG scrape (1 hashtag) → second row in /history; detail shows the IG-discovered leads
5. Trigger an error mid-scrape (e.g. invalid input) → status='error' visible in /history with the error message
