# Scrape History Implementation Plan

> **For Claude (next session):** REQUIRED SUB-SKILL: superpowers:executing-plans. No automated tests in this project — verify each task with the curl/browser command given. Pause for "Verify with Igor" checkpoints.

**Goal:** Persist a record of each scrape run (params, counts, status, leads it produced) so Igor can later browse a `/history` page and click into any run to see its leads.

**Architecture:** Two new tables (`scrape_runs` + `scrape_run_leads` M:N). Client orchestrates: creates a run before chunks fire, passes the `runId` into each chunk endpoint, finalizes once everything's done. Existing chunk endpoints (`/api/scrape`, `/api/scrape/discover-ig`) get a 5-line addition each: insert into `scrape_run_leads` for every upsert. New `/history` and `/history/[id]` pages reuse `<LeadsTable>` for the per-run lead view.

**Tech Stack:** Same as v1.

**Design doc:** `docs/plans/2026-05-14-scrape-history-design.md`.

---

## Pre-flight

### Task 0: Schema migration in Supabase

Tell Igor: open Supabase → SQL Editor → New query → paste this entire block → Run.

```sql
create table scrape_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  source text not null check (source in ('google', 'instagram')),
  params jsonb not null default '{}',
  counts jsonb not null default '{}',
  status text not null default 'running' check (status in ('running','done','error')),
  error_message text
);

create table scrape_run_leads (
  run_id uuid not null references scrape_runs(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  primary key (run_id, lead_id)
);

create index on scrape_run_leads(run_id);
create index on scrape_run_leads(lead_id);
```

Verify in Table Editor: both tables visible. Reply "schema done" before proceeding past Phase 1.

---

## Phase 1 — Types + helpers

### Task 1: Extend `lib/types.ts`

**Files:** Modify `lib/types.ts`

Append to end:

```ts
export type ScrapeSourceType = "google" | "instagram";
export type ScrapeRunStatus = "running" | "done" | "error";

export interface ScrapeCounts {
  found?: number;
  qualified?: number;
  new?: number;
  skipped?: number;
}

export interface ScrapeRun {
  id: string;
  started_at: string;
  ended_at: string | null;
  source: ScrapeSourceType;
  // Free-form per-source: for google { cities, terms, ... }; for IG { methods }.
  // Always also includes { rule, skipExisting } so we can replay if we ever
  // build re-run.
  params: Record<string, unknown>;
  counts: ScrapeCounts;
  status: ScrapeRunStatus;
  error_message: string | null;
}

export interface ScrapeRunWithLeads {
  run: ScrapeRun;
  leads: Lead[];
}
```

Verify: `npx tsc --noEmit` passes.

---

### Task 2: `lib/scrape-runs.ts`

**Files:** Create `lib/scrape-runs.ts`

```ts
import { getServerSupabase } from "@/lib/supabase-server";
import type { ScrapeCounts, ScrapeRunStatus, ScrapeSourceType } from "@/lib/types";

/** Insert a new scrape_runs row, return its id. Used by the client at scrape start. */
export async function createScrapeRun(
  source: ScrapeSourceType,
  params: Record<string, unknown>,
): Promise<string> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("scrape_runs")
    .insert({ source, params })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`createScrapeRun: ${error.message}`);
  if (!data?.id) throw new Error("createScrapeRun: no id returned");
  return data.id as string;
}

/** Finalize a run with status + final counts. Called at the end of the client orchestration. */
export async function finalizeScrapeRun(
  id: string,
  status: ScrapeRunStatus,
  counts: ScrapeCounts,
  errorMessage: string | null = null,
): Promise<void> {
  const supabase = getServerSupabase();
  const { error } = await supabase
    .from("scrape_runs")
    .update({
      ended_at: new Date().toISOString(),
      status,
      counts,
      error_message: errorMessage,
    })
    .eq("id", id);
  if (error) throw new Error(`finalizeScrapeRun: ${error.message}`);
}

/**
 * Link a set of lead ids to a scrape run. Best-effort: errors are swallowed
 * (logged) so a chunk doesn't fail just because the linking step had a hiccup.
 * Existing (run_id, lead_id) pairs are silently ignored via upsert/onConflict.
 */
export async function linkLeadsToRun(runId: string, leadIds: string[]): Promise<void> {
  if (leadIds.length === 0) return;
  const supabase = getServerSupabase();
  const rows = leadIds.map((lid) => ({ run_id: runId, lead_id: lid }));
  const { error } = await supabase
    .from("scrape_run_leads")
    .upsert(rows, { onConflict: "run_id,lead_id", ignoreDuplicates: true });
  if (error) {
    console.error(`linkLeadsToRun: ${error.message}`);
  }
}
```

Verify: `npx tsc --noEmit` passes.

**Step 3: Commit Phase 1**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add lib/types.ts lib/scrape-runs.ts
git commit -m "feat(history): types + helpers (createRun, finalizeRun, linkLeads)"
```

---

## Phase 2 — Run API endpoints

### Task 3: POST + GET `/api/scrape-runs`

**Files:** Create `app/api/scrape-runs/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { createScrapeRun } from "@/lib/scrape-runs";
import type { ScrapeRun, ScrapeSourceType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_SOURCES: ScrapeSourceType[] = ["google", "instagram"];

// GET /api/scrape-runs → reverse-chrono list of runs.
export async function GET() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("scrape_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json((data ?? []) as ScrapeRun[]);
}

// POST /api/scrape-runs → create a new run. Body: { source, params }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!VALID_SOURCES.includes(body.source)) {
    return NextResponse.json(
      { error: `source must be one of ${VALID_SOURCES.join(", ")}` },
      { status: 400 },
    );
  }
  const params =
    body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : {};
  try {
    const id = await createScrapeRun(body.source as ScrapeSourceType, params);
    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

Verify:
```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"source":"google","params":{"city":"X"}}' http://localhost:3000/api/scrape-runs | python3 -m json.tool
curl -s http://localhost:3000/api/scrape-runs | python3 -c "import sys,json;print(len(json.load(sys.stdin)),'runs')"
```

**No commit yet** — bundle Phase 2.

---

### Task 4: GET `/api/scrape-runs/[id]`

**Files:** Create `app/api/scrape-runs/[id]/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import type { Lead, ScrapeRun, ScrapeRunWithLeads } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ id: string }>; }

// GET /api/scrape-runs/:id → { run, leads: Lead[] }
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = getServerSupabase();

  const [runRes, linksRes] = await Promise.all([
    supabase.from("scrape_runs").select("*").eq("id", id).maybeSingle(),
    supabase.from("scrape_run_leads").select("lead_id").eq("run_id", id),
  ]);
  if (runRes.error) return NextResponse.json({ error: runRes.error.message }, { status: 500 });
  if (!runRes.data) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (linksRes.error) return NextResponse.json({ error: linksRes.error.message }, { status: 500 });

  const leadIds = (linksRes.data ?? []).map((l) => l.lead_id as string);
  let leads: Lead[] = [];
  if (leadIds.length > 0) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .in("id", leadIds)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    leads = (data ?? []) as Lead[];
  }

  const out: ScrapeRunWithLeads = { run: runRes.data as ScrapeRun, leads };
  return NextResponse.json(out);
}
```

---

### Task 5: POST `/api/scrape-runs/[id]/finalize`

**Files:** Create `app/api/scrape-runs/[id]/finalize/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { finalizeScrapeRun } from "@/lib/scrape-runs";
import type { ScrapeCounts, ScrapeRunStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ id: string }>; }

const VALID_STATUSES: ScrapeRunStatus[] = ["done", "error"];

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (!VALID_STATUSES.includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  const counts: ScrapeCounts = body.counts && typeof body.counts === "object" ? body.counts : {};
  const errorMessage = typeof body.error_message === "string" ? body.error_message : null;

  try {
    await finalizeScrapeRun(id, body.status as ScrapeRunStatus, counts, errorMessage);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

Verify: build passes, then commit Phase 2.

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npm run build 2>&1 | tail -10
git add app/api/scrape-runs
git commit -m "feat(history): /api/scrape-runs (list/create) + /[id] (detail) + /[id]/finalize"
```

---

## Phase 3 — Wire `runId` into chunk endpoints

### Task 6: `/api/scrape` accepts + links runId

**Files:** Modify `app/api/scrape/route.ts`

Add to imports:
```ts
import { linkLeadsToRun } from "@/lib/scrape-runs";
```

Add to `Body` interface:
```ts
interface Body {
  city?: string;
  term?: string;
  skipExisting?: boolean;
  rule?: Partial<QualificationRule>;
  runId?: string;  // NEW
}
```

In the route handler, parse runId after body parsing:
```ts
const runId = typeof body.runId === "string" ? body.runId : null;
```

In the SSE stream, AFTER the upsert success, BEFORE the final `done` event, add:
```ts
        // Link these leads to the run (best-effort; doesn't fail the chunk).
        if (runId && rows.length > 0) {
          // We just upserted by place_id; fetch back the ids for linking.
          const { data: linked } = await supabase
            .from("leads")
            .select("id")
            .in("place_id", rows.map((r) => r.place_id));
          await linkLeadsToRun(runId, (linked ?? []).map((l) => l.id as string));
        }
```

Verify: tsc passes.

---

### Task 7: `/api/scrape/discover-ig` accepts + links runId

**Files:** Modify `app/api/scrape/discover-ig/route.ts`

Add to imports:
```ts
import { linkLeadsToRun } from "@/lib/scrape-runs";
```

Add to `Body` interface:
```ts
interface Body {
  method?: DiscoveryMethod;
  values?: string[];
  skipExisting?: boolean;
  rule?: Partial<QualificationRule>;
  runId?: string;  // NEW
}
```

In the route handler, parse:
```ts
const runId = typeof body.runId === "string" ? body.runId : null;
```

After the IG upsert success, BEFORE the final `done` event:
```ts
        if (runId && rows.length > 0) {
          const { data: linked } = await supabase
            .from("leads")
            .select("id")
            .in("place_id", rows.map((r) => r.place_id));
          await linkLeadsToRun(runId, (linked ?? []).map((l) => l.id as string));
        }
```

Verify: build passes; commit Phase 3.
```bash
git add app/api/scrape/route.ts app/api/scrape/discover-ig/route.ts
git commit -m "feat(history): chunk endpoints accept runId + link upserted leads"
```

---

## Phase 4 — Client orchestration

### Task 8: `scrape-client.tsx` wraps each run

**Files:** Modify `components/scrape-client.tsx`

In `runGoogleScrape`, replace the function body with:

```ts
  async function runGoogleScrape(req: ScrapeRequest) {
    setEvents([]);
    setRunning(true);

    // Create the run record up front
    let runId: string | null = null;
    try {
      const r = await fetch("/api/scrape-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "google", params: req }),
      });
      if (r.ok) runId = (await r.json()).id;
    } catch {}

    let hadError = false;
    const totals = { found: 0, qualified: 0, new: 0, skipped: 0 };

    try {
      const totalCombos = req.cities.length * req.terms.length;
      let comboIdx = 0;
      append({
        stage: "searching",
        message: `Starting ${totalCombos} chunk${totalCombos === 1 ? "" : "s"} (${req.cities.length} cities × ${req.terms.length} terms)…`,
      });

      for (const city of req.cities) {
        for (const term of req.terms) {
          comboIdx++;
          append({
            stage: "searching",
            city,
            term,
            message: `Chunk ${comboIdx}/${totalCombos}: ${city} / ${term}`,
          });
          const last = await streamPost("/api/scrape", {
            city,
            term,
            skipExisting: req.skipExisting,
            rule: req.rule,
            runId,
          });
          if (last?.stage === "error") hadError = true;
          if (last?.counts) {
            totals.found += last.counts.found ?? 0;
            totals.qualified += last.counts.qualified ?? 0;
            totals.new += last.counts.new ?? 0;
            totals.skipped += last.counts.skipped ?? 0;
          }
        }
      }

      if (req.enrichInstagram) {
        append({ stage: "enriching", message: "Starting Instagram enrichment phase…" });
        const SAFETY_CAP = 300;
        let i = 0;
        while (i++ < SAFETY_CAP) {
          const last = await streamPost("/api/scrape/enrich", { batchSize: 3 });
          if (!last) break;
          if (last.stage === "error") { hadError = true; break; }
          const remaining = last.counts?.remaining ?? 0;
          if (remaining <= 0) break;
        }
        if (i >= SAFETY_CAP) {
          append({ stage: "error", message: `Hit safety cap (${SAFETY_CAP} batches).` });
          hadError = true;
        }
      }

      append({ stage: "done", message: "Scrape complete." });
    } catch (err) {
      hadError = true;
      append({ stage: "error", message: `Run failed: ${(err as Error).message}` });
    } finally {
      setRunning(false);
      // Finalize the run record (best-effort)
      if (runId) {
        try {
          await fetch(`/api/scrape-runs/${runId}/finalize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: hadError ? "error" : "done",
              counts: totals,
            }),
          });
        } catch {}
      }
    }
  }
```

Same treatment for `runInstagramScrape` — replace its body:

```ts
  async function runInstagramScrape(req: InstagramScrapeRequest) {
    setEvents([]);
    setRunning(true);

    let runId: string | null = null;
    try {
      const r = await fetch("/api/scrape-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "instagram", params: req }),
      });
      if (r.ok) runId = (await r.json()).id;
    } catch {}

    let hadError = false;
    const totals = { found: 0, qualified: 0, new: 0, skipped: 0 };

    try {
      append({
        stage: "searching",
        message: `Starting ${req.methods.length} IG discovery method${req.methods.length === 1 ? "" : "s"}…`,
      });
      for (const m of req.methods) {
        append({
          stage: "searching",
          message: `Method: ${m.method} (${m.values.length} value${m.values.length === 1 ? "" : "s"})`,
        });
        const last = await streamPost("/api/scrape/discover-ig", {
          method: m.method,
          values: m.values,
          skipExisting: req.skipExisting,
          rule: req.rule,
          runId,
        });
        if (last?.stage === "error") hadError = true;
        if (last?.counts) {
          totals.found += last.counts.found ?? 0;
          totals.qualified += last.counts.qualified ?? 0;
          totals.new += last.counts.new ?? 0;
          totals.skipped += last.counts.skipped ?? 0;
        }
      }
      append({ stage: "done", message: "IG scrape complete." });
    } catch (err) {
      hadError = true;
      append({ stage: "error", message: `Run failed: ${(err as Error).message}` });
    } finally {
      setRunning(false);
      if (runId) {
        try {
          await fetch(`/api/scrape-runs/${runId}/finalize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: hadError ? "error" : "done",
              counts: totals,
            }),
          });
        } catch {}
      }
    }
  }
```

Verify: build passes. Don't commit yet — Phase 5 next.

---

## Phase 5 — UI pages

### Task 9: `/history` list page

**Files:** Create `app/history/page.tsx`

```tsx
import Link from "next/link";
import { getServerSupabase } from "@/lib/supabase-server";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRelativeTime } from "@/lib/format";
import type { ScrapeRun } from "@/lib/types";

export const dynamic = "force-dynamic";

function summariseParams(run: ScrapeRun): string {
  const p = run.params as Record<string, unknown>;
  if (run.source === "google") {
    const cities = Array.isArray(p.cities) ? (p.cities as string[]) : [];
    const terms = Array.isArray(p.terms) ? (p.terms as string[]) : [];
    return `${cities.length} cit${cities.length === 1 ? "y" : "ies"} × ${terms.length} term${terms.length === 1 ? "" : "s"}`;
  }
  if (run.source === "instagram") {
    const methods = Array.isArray(p.methods) ? (p.methods as Array<{ method: string; values: string[] }>) : [];
    if (methods.length === 0) return "—";
    return methods.map((m) => `${m.method} (${m.values.length})`).join(", ");
  }
  return "—";
}

export default async function HistoryPage() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("scrape_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(200);

  if (error) {
    return (
      <main className="mx-auto max-w-screen-2xl p-6">
        <p className="text-destructive">Error loading history: {error.message}</p>
      </main>
    );
  }

  const runs = (data ?? []) as ScrapeRun[];

  return (
    <main className="mx-auto max-w-screen-2xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Scrape history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Past runs with their params and outcomes. Click a row to see the leads it produced.
        </p>
      </header>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
          <p>No scrape runs yet.</p>
          <Link href="/scrape" className="text-sm underline underline-offset-4">
            Go to /scrape →
          </Link>
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Params</TableHead>
                <TableHead className="text-right">Found</TableHead>
                <TableHead className="text-right">Qualified</TableHead>
                <TableHead className="text-right">New</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const c = run.counts ?? {};
                return (
                  <TableRow key={run.id}>
                    <TableCell title={new Date(run.started_at).toLocaleString("hr")} className="text-xs text-muted-foreground">
                      {formatRelativeTime(run.started_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{run.source}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{summariseParams(run)}</TableCell>
                    <TableCell className="text-right">{c.found ?? 0}</TableCell>
                    <TableCell className="text-right">{c.qualified ?? 0}</TableCell>
                    <TableCell className="text-right">{c.new ?? 0}</TableCell>
                    <TableCell className="text-right">{c.skipped ?? 0}</TableCell>
                    <TableCell>
                      {run.status === "done" ? (
                        <span className="text-green-300">✓ done</span>
                      ) : run.status === "error" ? (
                        <span className="text-destructive" title={run.error_message ?? ""}>⚠️ error</span>
                      ) : (
                        <span className="text-muted-foreground">… running</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link href={`/history/${run.id}`} className="text-xs underline-offset-4 hover:underline">
                        View
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
```

---

### Task 10: `/history/[id]` detail page

**Files:** Create `app/history/[id]/page.tsx`

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase-server";
import { Badge } from "@/components/ui/badge";
import { LeadsTable } from "@/components/leads-table";
import { formatRelativeTime } from "@/lib/format";
import type { Lead, ScrapeRun } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PageProps { params: Promise<{ id: string }>; }

export default async function HistoryDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = getServerSupabase();

  const [runRes, linksRes] = await Promise.all([
    supabase.from("scrape_runs").select("*").eq("id", id).maybeSingle(),
    supabase.from("scrape_run_leads").select("lead_id").eq("run_id", id),
  ]);

  if (runRes.error) {
    return (
      <main className="mx-auto max-w-screen-xl p-6">
        <p className="text-destructive">Error loading run: {runRes.error.message}</p>
      </main>
    );
  }
  if (!runRes.data) notFound();

  const run = runRes.data as ScrapeRun;
  const leadIds = ((linksRes.data ?? []) as Array<{ lead_id: string }>).map((l) => l.lead_id);

  let leads: Lead[] = [];
  if (leadIds.length > 0) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .in("id", leadIds)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });
    if (!error) leads = (data ?? []) as Lead[];
  }

  const c = run.counts ?? {};

  return (
    <main className="mx-auto max-w-screen-2xl space-y-6 p-6">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-border pb-4">
        <Link href="/history" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          ← All runs
        </Link>
        <h1 className="text-xl font-semibold">{run.source} scrape</h1>
        <span className="text-xs text-muted-foreground" title={new Date(run.started_at).toLocaleString("hr")}>
          {formatRelativeTime(run.started_at)}
        </span>
        <Badge variant="secondary">
          {run.status === "done" ? "✓ done" : run.status === "error" ? "⚠️ error" : "… running"}
        </Badge>
      </header>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Found" value={c.found ?? 0} />
        <Stat label="Qualified" value={c.qualified ?? 0} />
        <Stat label="New" value={c.new ?? 0} />
        <Stat label="Skipped" value={c.skipped ?? 0} />
      </section>

      {run.error_message ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {run.error_message}
        </p>
      ) : null}

      <details className="rounded-md border border-border p-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Params</summary>
        <pre className="mt-2 overflow-x-auto text-[11px] leading-tight">
          {JSON.stringify(run.params, null, 2)}
        </pre>
      </details>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Leads from this run ({leads.length})
        </h2>
        {leads.length === 0 ? (
          <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
            No leads linked to this run.
          </p>
        ) : (
          <LeadsTable leads={leads} />
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
```

---

### Task 11: Add History nav link

**Files:** Modify `app/layout.tsx`

After the existing `<Link href="/scrape">…</Link>` and BEFORE the `{user ? …}` block, insert:

```tsx
          <Link href="/history" className="text-muted-foreground hover:text-foreground">
            History
          </Link>
```

Verify: build passes; commit Phases 4 + 5 together.

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npm run build 2>&1 | tail -10
git add components/scrape-client.tsx app/history app/layout.tsx
git commit -m "feat(history): client orchestration + /history list + /history/[id] detail + nav"
```

---

## Phase 6 — Verify + ship

### Task 12: Local end-to-end smoke test

Restart dev:
```bash
pkill -f "next dev"; sleep 1
cd /Users/chartfumonkey/Code/fit-leads-hr && rm -rf .next && npm run dev &
```

In browser:
1. `/scrape` → Google → Čakovec + fitness coach → Run → wait for "Scrape complete."
2. `/history` → first row shows the just-completed run with non-zero counts
3. Click "View" → detail page shows the run's leads (use the existing LeadsTable)
4. `/scrape` → Instagram → 1 hashtag (e.g. `kineziolog`) → Run → wait
5. `/history` → second row shows the IG run
6. Click "View" → detail page shows the IG-discovered leads

### Task 13: Push (gh dance) + Igor verifies on prod

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
gh auth switch -u digitalizirajhr
git push
gh auth switch -u ChartFuMonkey
```

Igor confirms `/history` works on the deployed app after Vercel rebuilds.

---

## Build verification checklist

Before each push: `npm run build` must succeed with no type errors.

## Rollback notes

The schema is additive (two new tables, no changes to `leads`). To roll back:
- `drop table scrape_run_leads; drop table scrape_runs;` in Supabase
- `git revert` the relevant commits
- The chunk endpoints will silently no-op the link step when `runId` is absent (already handles that case).
