# Instagram Discovery + Multi-Step Scrape — Implementation Plan

> **For Claude (next session):** REQUIRED SUB-SKILL: superpowers:executing-plans. No automated tests in this project — verify each task with the curl/browser command given. Pause at each "Verify with Igor" checkpoint.

**Goal:** Add Instagram-source lead discovery (4 methods: hashtag, location, seed-account followers, bio keyword search) plus AI-assisted bio filtering, behind a new two-step picker UI on /scrape (Source → details).

**Architecture:** Same chunked SSE pipeline as the existing Google scrape — each Vercel call processes one (method × value-batch) and stays under 60s. New `/api/scrape/discover-ig` endpoint runs: discover → dedupe → skip-existing → enrich (existing instagram-profile-scraper) → keyword-filter on bio → optional Claude Haiku fallback for misses → upsert into `leads` with synthetic `place_id = "ig:<handle>"`. UI is a 2-step form owned by `scrape-client.tsx`.

**Tech Stack:** Same as v1 + Apify actors `apify/instagram-hashtag-scraper`, `apify/instagram-scraper` (for location + user search), `apify/instagram-follower-scraper`, plus the Anthropic API (Claude Haiku) via raw fetch (no new SDK dep).

**Design doc:** `docs/plans/2026-05-14-instagram-discovery-and-multistep-scrape-design.md`.

---

## Pre-flight

### Task 0: Igor sets up an Anthropic API key (OPTIONAL)

The AI bio-classifier fallback works only if `ANTHROPIC_API_KEY` is set. Without it, the pipeline degrades gracefully to keyword-only filtering — valid but slightly more false-negatives.

Tell Igor: skip if you don't want the AI safety net. If you do want it:

1. https://console.anthropic.com → sign in or sign up
2. Top-right account menu → **API Keys** → **Create Key**
3. Name it `fit-leads-hr` → copy the `sk-ant-...` value
4. Add to `~/Code/fit-leads-hr/.env.local` as `ANTHROPIC_API_KEY=sk-ant-...`
5. Add same to Vercel → Project Settings → Environment Variables (Production + Preview + Development)
6. Set a billing limit at console.anthropic.com → Settings → Limits → $5/month is plenty

Reply "ai key set" or "skip ai" so I know which path to test against.

---

## Phase 1 — Backend libs

### Task 1: `lib/instagram-discovery.ts`

**Files:**
- Create: `lib/instagram-discovery.ts`

**Step 1: Write file**

```ts
// Wrappers around the 4 Apify discovery actors used by /api/scrape/discover-ig.
// Each returns a list of unique IG handles (lowercased). Internally each capped
// at MAX_RESULTS_PER_CALL so a single Apify call fits Vercel's 60s timeout.

const MAX_RESULTS_PER_CALL = 100;

const HASHTAG_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items";
const SEARCH_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items";
const FOLLOWERS_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-follower-scraper/run-sync-get-dataset-items";

export type DiscoveryMethod = "hashtag" | "location" | "seed" | "bio_keyword";

interface ApifyPost { ownerUsername?: string; }
interface ApifyUser { username?: string; }
interface ApifyFollower { username?: string; }

function uniqueLower(handles: Array<string | undefined | null>): string[] {
  const out = new Set<string>();
  for (const h of handles) {
    if (!h) continue;
    const cleaned = h.trim().toLowerCase();
    if (cleaned) out.add(cleaned);
  }
  return Array.from(out);
}

async function postJson<T>(url: string, body: object): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Hashtag scrape → unique post-author usernames. */
export async function discoverByHashtags(
  hashtags: string[],
  apifyToken: string,
): Promise<string[]> {
  const cleaned = hashtags.map((h) => h.replace(/^#/, "").trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const url = `${HASHTAG_ENDPOINT}?token=${apifyToken}`;
  const items = await postJson<ApifyPost[]>(url, {
    hashtags: cleaned,
    resultsLimit: MAX_RESULTS_PER_CALL,
  });
  return uniqueLower(items.map((p) => p.ownerUsername));
}

/** Location-name search → unique authors of recent posts at those locations. */
export async function discoverByLocations(
  locationNames: string[],
  apifyToken: string,
): Promise<string[]> {
  const cleaned = locationNames.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const url = `${SEARCH_ENDPOINT}?token=${apifyToken}`;
  // instagram-scraper accepts directUrls — we pass the search-by-place URLs.
  const items = await postJson<ApifyPost[]>(url, {
    search: cleaned.join(","),
    searchType: "place",
    resultsType: "posts",
    resultsLimit: MAX_RESULTS_PER_CALL,
  });
  return uniqueLower(items.map((p) => p.ownerUsername));
}

/** Followers + followings of given seed accounts. */
export async function discoverBySeedFollowers(
  seedUsernames: string[],
  apifyToken: string,
): Promise<string[]> {
  const cleaned = seedUsernames.map((u) => u.replace(/^@/, "").trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const url = `${FOLLOWERS_ENDPOINT}?token=${apifyToken}`;
  const items = await postJson<ApifyFollower[]>(url, {
    usernames: cleaned,
    resultsLimit: MAX_RESULTS_PER_CALL,
  });
  return uniqueLower(items.map((f) => f.username));
}

/** Bio/user keyword search → matching usernames. */
export async function discoverByBioKeywords(
  keywords: string[],
  apifyToken: string,
): Promise<string[]> {
  const cleaned = keywords.map((k) => k.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const url = `${SEARCH_ENDPOINT}?token=${apifyToken}`;
  const items = await postJson<ApifyUser[]>(url, {
    search: cleaned.join(" "),
    searchType: "user",
    resultsType: "users",
    resultsLimit: MAX_RESULTS_PER_CALL,
  });
  return uniqueLower(items.map((u) => u.username));
}

/** Dispatcher: one method, one set of values → handles. */
export async function discoverHandles(
  method: DiscoveryMethod,
  values: string[],
  apifyToken: string,
): Promise<string[]> {
  switch (method) {
    case "hashtag":     return discoverByHashtags(values, apifyToken);
    case "location":    return discoverByLocations(values, apifyToken);
    case "seed":        return discoverBySeedFollowers(values, apifyToken);
    case "bio_keyword": return discoverByBioKeywords(values, apifyToken);
  }
}
```

**Step 2: Verify**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npx tsc --noEmit
```
Expected: zero errors.

**No commit yet** — bundle with Task 2.

---

### Task 2: `lib/coach-classifier.ts`

**Files:**
- Create: `lib/coach-classifier.ts`

**Step 1: Write file**

```ts
// Two-stage classifier: cheap keyword check + (optional) AI fallback for misses.
// Returns the subset of EnrichedProfile that should be kept as fitness coaches.

import type { EnrichedProfile } from "@/lib/instagram";

// Croatian + English fitness/sports terms. Lowercase substring match against bio.
const COACH_KEYWORDS = [
  "trener", "trenerica", "trening",
  "coach", "fitness", "kineziolog", "kineziologija",
  "personalni trener", "personal trainer",
  "bodybuilder", "bodybuilding",
  "sportaš", "sportašica", "sport",
  "powerlifting", "weightlifting",
  "yoga", "joga", "pilates", "crossfit",
  "nutricionist", "nutritionist",
];

function passesKeywordFilter(bio: string | null): boolean {
  if (!bio) return false;
  const lower = bio.toLowerCase();
  return COACH_KEYWORDS.some((k) => lower.includes(k));
}

/** AI fallback: ask Claude Haiku if the bio describes a fitness pro.
 *  Returns true on YES, false on NO or any error (fail-closed). */
async function aiClassifyBio(bio: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 5,
        messages: [
          {
            role: "user",
            content: `Instagram bio: "${bio}"\n\nIs this person a fitness or sports professional in Croatia (trainer, coach, kinesiologist, athlete, gym owner)? Reply only YES or NO.`,
          },
        ],
      }),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = json.content?.[0]?.text?.trim().toUpperCase() ?? "";
    return text.startsWith("YES");
  } catch {
    return false;
  }
}

/**
 * Filter profiles to those plausibly being fitness coaches.
 *   - Pass 1: bio keyword match → keep
 *   - Pass 2 (only if ANTHROPIC_API_KEY set): AI fallback for keyword misses
 *
 * Returns the kept profiles in the same order as input.
 */
export async function filterCoaches(
  profiles: EnrichedProfile[],
  opts?: { onAiCall?: (count: number) => void },
): Promise<EnrichedProfile[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const kept: EnrichedProfile[] = [];
  const aiCandidates: EnrichedProfile[] = [];

  for (const p of profiles) {
    if (passesKeywordFilter(p.bio)) {
      kept.push(p);
    } else if (apiKey && p.bio && p.bio.trim().length > 0) {
      aiCandidates.push(p);
    }
  }

  if (apiKey && aiCandidates.length > 0) {
    opts?.onAiCall?.(aiCandidates.length);
    // Sequential to keep cost / rate-limit predictable — Haiku is fast enough.
    for (const p of aiCandidates) {
      const isCoach = await aiClassifyBio(p.bio!, apiKey);
      if (isCoach) kept.push(p);
    }
  }

  return kept;
}
```

**Step 2: Verify**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npx tsc --noEmit
```
Expected: zero errors.

**Step 3: Commit Phase 1**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git add lib/instagram-discovery.ts lib/coach-classifier.ts
git commit -m "feat(ig): discovery wrappers (4 methods) + coach classifier (keyword + AI)"
```

---

## Phase 2 — API endpoint

### Task 3: `app/api/scrape/discover-ig/route.ts`

**Files:**
- Create: `app/api/scrape/discover-ig/route.ts`

**Step 1: Write file**

```ts
import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { enrichAll } from "@/lib/instagram";
import { discoverHandles, type DiscoveryMethod } from "@/lib/instagram-discovery";
import { filterCoaches } from "@/lib/coach-classifier";
import { computeQualified } from "@/lib/qualification";
import { requireAuth } from "@/lib/require-auth";
import { DEFAULT_RULE, type QualificationRule, type ScrapeEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  method?: DiscoveryMethod;
  values?: string[];
  skipExisting?: boolean;
  rule?: Partial<QualificationRule>;
}

const VALID_METHODS: DiscoveryMethod[] = ["hashtag", "location", "seed", "bio_keyword"];

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) {
    return new Response(
      JSON.stringify({ error: "APIFY_TOKEN is not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const body: Body = await req.json().catch(() => ({}));
  const method = body.method;
  const values = Array.isArray(body.values) ? body.values.filter((v) => typeof v === "string") : [];
  const skipExisting = body.skipExisting !== false;
  const rule: QualificationRule = { ...DEFAULT_RULE, ...(body.rule ?? {}) };

  if (!method || !VALID_METHODS.includes(method)) {
    return new Response(
      JSON.stringify({ error: `method must be one of ${VALID_METHODS.join(", ")}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (values.length === 0) {
    return new Response(
      JSON.stringify({ error: "values must be a non-empty string array" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ScrapeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const term = `${method}:${values.join(",").slice(0, 60)}`; // for SSE event labels

      try {
        // ---- 1. Discover handles ----
        send({ stage: "searching", term, message: `Discovering via ${method}: ${values.join(", ")}…` });
        const candidates = await discoverHandles(method, values, apifyToken);
        send({
          stage: "searching",
          term,
          message: `Found ${candidates.length} candidate handles`,
          counts: { found: candidates.length },
        });

        if (candidates.length === 0) {
          send({
            stage: "done",
            term,
            message: `No candidates from ${method}.`,
            counts: { found: 0, qualified: 0, new: 0, skipped: 0 },
          });
          controller.close();
          return;
        }

        const supabase = getServerSupabase();

        // ---- 2. Skip-existing ----
        let toEnrich = candidates;
        let skippedExisting = 0;
        if (skipExisting) {
          const placeIds = candidates.map((h) => `ig:${h}`);
          const { data: existing, error } = await supabase
            .from("leads")
            .select("place_id, instagram_handle")
            .or(`place_id.in.(${placeIds.map((p) => `"${p}"`).join(",")}),instagram_handle.in.(${candidates.map((h) => `"${h}"`).join(",")})`);
          if (error) throw new Error(`Existing-check: ${error.message}`);
          const existingSet = new Set<string>();
          for (const r of existing ?? []) {
            if (r.instagram_handle) existingSet.add((r.instagram_handle as string).toLowerCase());
            if (r.place_id) {
              const pid = r.place_id as string;
              if (pid.startsWith("ig:")) existingSet.add(pid.slice(3));
            }
          }
          toEnrich = candidates.filter((h) => !existingSet.has(h));
          skippedExisting = candidates.length - toEnrich.length;
          send({
            stage: "filtering",
            term,
            message: `Skipped ${skippedExisting} already in DB; enriching ${toEnrich.length}`,
            counts: { skipped: skippedExisting },
          });
        }

        if (toEnrich.length === 0) {
          send({
            stage: "done",
            term,
            message: `Nothing new (${skippedExisting} already in DB).`,
            counts: { found: candidates.length, qualified: 0, new: 0, skipped: skippedExisting },
          });
          controller.close();
          return;
        }

        // ---- 3. Enrich via existing instagram-profile-scraper ----
        send({ stage: "enriching", term, message: `Enriching ${toEnrich.length} profiles…` });
        const enrichedMap = await enrichAll(toEnrich, apifyToken);
        const enriched = Array.from(enrichedMap.values());
        send({
          stage: "enriching",
          term,
          message: `Got ${enriched.length} profiles back`,
          counts: { found: enriched.length },
        });

        // ---- 4. Coach filter (keyword + AI fallback) ----
        send({ stage: "filtering", term, message: `Filtering for fitness coaches…` });
        const coaches = await filterCoaches(enriched, {
          onAiCall: (n) =>
            send({
              stage: "filtering",
              term,
              message: `${n} bios sent to AI classifier (keyword fallback)`,
            }),
        });
        send({
          stage: "filtering",
          term,
          message: `${coaches.length} of ${enriched.length} look like coaches`,
        });

        if (coaches.length === 0) {
          send({
            stage: "done",
            term,
            message: `No coaches kept after filter.`,
            counts: { found: candidates.length, qualified: 0, new: 0, skipped: skippedExisting },
          });
          controller.close();
          return;
        }

        // ---- 5. Build rows + upsert ----
        const rows = coaches.map((p) => {
          const placeId = `ig:${p.handle}`;
          const partial = {
            has_real_website: false,
            phone: null as string | null,
            google_rating: null as number | null,
            google_review_count: null as number | null,
            instagram_handle: p.handle,
            instagram_followers: p.followers,
            instagram_is_active: p.isActive,
            city: null as string | null,
          };
          return {
            place_id: placeId,
            name: p.handle, // No fullName field on EnrichedProfile; use handle
            phone: null,
            current_website: `https://instagram.com/${p.handle}`,
            address: null,
            city: null,
            latitude: null,
            longitude: null,
            google_rating: null,
            google_review_count: null,
            instagram_handle: p.handle,
            instagram_followers: p.followers,
            instagram_bio: p.bio,
            instagram_last_post_at: p.latestPostAt,
            instagram_is_active: p.isActive,
            has_real_website: false,
            qualified: computeQualified(partial, rule),
          };
        });

        const qualifiedCount = rows.filter((r) => r.qualified).length;
        send({ stage: "saving", term, message: `Upserting ${rows.length} (${qualifiedCount} qualified)…` });

        const { error: upsertErr } = await supabase
          .from("leads")
          .upsert(rows, { onConflict: "place_id" });
        if (upsertErr) throw new Error(`Upsert: ${upsertErr.message}`);

        send({
          stage: "done",
          term,
          message: `Done ${method}: +${rows.length} (${qualifiedCount} qualified, ${skippedExisting} skipped)`,
          counts: {
            found: candidates.length,
            qualified: qualifiedCount,
            new: rows.length,
            skipped: skippedExisting,
          },
        });
      } catch (err) {
        send({ stage: "error", term, message: `Error: ${(err as Error).message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

**Step 2: Verify**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npm run build 2>&1 | tail -10
```
Expected: build succeeds, the new route shows up in the printed route table as `/api/scrape/discover-ig`.

**Step 3: Commit**

```bash
git add app/api/scrape/discover-ig/route.ts
git commit -m "feat(api): /api/scrape/discover-ig — chunked IG discovery pipeline"
```

---

## Phase 3 — Multi-step UI

### Task 4: `components/scrape-source-picker.tsx`

**Files:**
- Create: `components/scrape-source-picker.tsx`

**Step 1: Write**

```tsx
"use client";

import { Button } from "@/components/ui/button";

export type ScrapeSource = "google" | "instagram";

interface Props {
  onPick: (source: ScrapeSource) => void;
}

/**
 * Step 1 of the /scrape multi-step form. Two cards, single choice.
 */
export function ScrapeSourcePicker({ onPick }: Props) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card
        title="Google Business"
        body="Gyms, fitness studios, and small fitness businesses with phone numbers from Google Maps. Best for established businesses you can cold-call."
        cta="Pick Google"
        onClick={() => onPick("google")}
      />
      <Card
        title="Instagram"
        body="Individual personal trainers via hashtag, location, seed accounts you trust, or bio keyword search. Best for solo coaches who don't have a Google business listing."
        cta="Pick Instagram"
        onClick={() => onPick("instagram")}
      />
    </div>
  );
}

function Card({
  title,
  body,
  cta,
  onClick,
}: {
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-lg border border-border p-6 text-left transition-colors hover:border-foreground/40 hover:bg-muted/30"
    >
      <h3 className="text-base font-medium">{title}</h3>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Button size="sm" variant="outline" className="self-start">
        {cta} →
      </Button>
    </button>
  );
}
```

**No commit yet** — bundle with Task 5.

---

### Task 5: `components/scrape-form-instagram.tsx`

**Files:**
- Create: `components/scrape-form-instagram.tsx`

**Step 1: Write**

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { QualificationRuleForm } from "@/components/qualification-rule-form";
import type { DiscoveryMethod } from "@/lib/instagram-discovery";
import type { QualificationRule } from "@/lib/types";

export interface InstagramScrapeRequest {
  methods: Array<{ method: DiscoveryMethod; values: string[] }>;
  skipExisting: boolean;
  rule: QualificationRule;
}

interface Props {
  onSubmit: (req: InstagramScrapeRequest) => void;
  onBack: () => void;
  running: boolean;
  rule: QualificationRule;
  onRuleChange: (next: QualificationRule) => void;
  citiesInDb: string[];
}

export function ScrapeFormInstagram({
  onSubmit,
  onBack,
  running,
  rule,
  onRuleChange,
  citiesInDb,
}: Props) {
  const [hashtags, setHashtags] = useState("");
  const [locations, setLocations] = useState("");
  const [seeds, setSeeds] = useState("");
  const [bioKeywords, setBioKeywords] = useState("");
  const [skipExisting, setSkipExisting] = useState(true);

  function parseList(s: string): string[] {
    return s
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const methods = [
    { method: "hashtag" as const, values: parseList(hashtags) },
    { method: "location" as const, values: parseList(locations) },
    { method: "seed" as const, values: parseList(seeds) },
    { method: "bio_keyword" as const, values: parseList(bioKeywords) },
  ].filter((m) => m.values.length > 0);

  const canRun = methods.length > 0 && !running;

  return (
    <div className="space-y-6 rounded-lg border border-border p-6">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Back to source picker
      </button>

      <div>
        <h2 className="text-base font-medium">Instagram discovery</h2>
        <p className="text-xs text-muted-foreground">
          Fill in any combination — empty fields are skipped.
        </p>
      </div>

      <Field
        label="Hashtags"
        hint='Comma-separated, no #. e.g. "personalnitrenerzagreb, fitnesstrenerhrvatska"'
        value={hashtags}
        onChange={setHashtags}
      />
      <Field
        label="Locations"
        hint='Comma-separated location names. e.g. "Zagreb, Split, Crossfit Zagreb"'
        value={locations}
        onChange={setLocations}
      />
      <Field
        label="Seed accounts"
        hint='Comma-separated usernames, no @. e.g. "iyaprivanovic, vilim.puclin". Pulls their followers.'
        value={seeds}
        onChange={setSeeds}
      />
      <Field
        label="Bio keyword search"
        hint='Comma-separated keywords. e.g. "kineziolog zagreb, fitness trener split"'
        value={bioKeywords}
        onChange={setBioKeywords}
      />

      <div className="border-t border-border pt-4">
        <label className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm">Skip leads I already have</Label>
            <p className="text-xs text-muted-foreground">
              Dedupe by IG handle / synthetic ig:HANDLE place_id against the existing DB.
            </p>
          </div>
          <Switch checked={skipExisting} onCheckedChange={setSkipExisting} />
        </label>
      </div>

      <div className="border-t border-border pt-4 space-y-2">
        <h3 className="text-sm font-medium">Qualification criteria</h3>
        <p className="text-xs text-muted-foreground">resets on reload</p>
        <QualificationRuleForm rule={rule} onChange={onRuleChange} cities={citiesInDb} />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">
          {methods.length === 0
            ? "Fill in at least one discovery field"
            : `${methods.length} method${methods.length === 1 ? "" : "s"} ready · ` +
              `${methods.reduce((n, m) => n + m.values.length, 0)} total queries`}
        </p>
        <Button
          onClick={() =>
            onSubmit({ methods, skipExisting, rule })
          }
          disabled={!canRun}
          size="lg"
        >
          {running ? "Running…" : "Run scrape"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-sm">{label}</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-8 max-w-2xl" />
    </div>
  );
}
```

**No commit yet** — bundle with Task 6 + 7.

---

### Task 6: Update `components/scrape-form.tsx` to accept an `onBack` prop

**Files:**
- Modify: `components/scrape-form.tsx`

**Step 1: Patch**

Add `onBack` to the `Props` interface:
```ts
interface Props {
  onSubmit: (req: ScrapeRequest) => void;
  running: boolean;
  customTerms: string[];
  rule: QualificationRule;
  onRuleChange: (next: QualificationRule) => void;
  citiesInDb: string[];
  onBack: () => void; // NEW
}
```

In the function signature destructure:
```ts
export function ScrapeForm({
  onSubmit,
  running,
  customTerms,
  rule,
  onRuleChange,
  citiesInDb,
  onBack,
}: Props) {
```

At the very top of the returned JSX (before the Cities section), insert:
```tsx
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Back to source picker
      </button>
```

---

### Task 7: Rewrite `components/scrape-client.tsx` to own the multi-step state

**Files:**
- Modify: `components/scrape-client.tsx`

**Step 1: Replace the file with:**

```tsx
"use client";

import { useState } from "react";
import { ScrapeForm, type ScrapeRequest } from "@/components/scrape-form";
import {
  ScrapeFormInstagram,
  type InstagramScrapeRequest,
} from "@/components/scrape-form-instagram";
import { ScrapeProgress } from "@/components/scrape-progress";
import {
  ScrapeSourcePicker,
  type ScrapeSource,
} from "@/components/scrape-source-picker";
import { DEFAULT_RULE, type QualificationRule, type ScrapeEvent } from "@/lib/types";

interface ScrapeClientProps {
  initialCustomTerms: string[];
  citiesInDb: string[];
}

export function ScrapeClient({ initialCustomTerms, citiesInDb }: ScrapeClientProps) {
  const [source, setSource] = useState<ScrapeSource | null>(null);
  const [events, setEvents] = useState<ScrapeEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [rule, setRule] = useState<QualificationRule>(DEFAULT_RULE);

  function append(ev: ScrapeEvent) {
    setEvents((prev) => [...prev, ev]);
  }

  async function streamPost(url: string, body: object): Promise<ScrapeEvent | null> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const ev: ScrapeEvent = {
        stage: "error",
        message: `Network error hitting ${url}: ${(err as Error).message}`,
      };
      append(ev);
      return ev;
    }
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      const ev: ScrapeEvent = {
        stage: "error",
        message: `${url} ${res.status}: ${txt || res.statusText}`,
      };
      append(ev);
      return ev;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let last: ScrapeEvent | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload) as ScrapeEvent;
            append(ev);
            last = ev;
          } catch {
            const ev: ScrapeEvent = { stage: "error", message: `Bad SSE: ${payload}` };
            append(ev);
            last = ev;
          }
        }
      }
    }
    return last;
  }

  async function runGoogleScrape(req: ScrapeRequest) {
    setEvents([]);
    setRunning(true);
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
          await streamPost("/api/scrape", {
            city,
            term,
            skipExisting: req.skipExisting,
            rule: req.rule,
          });
        }
      }
      if (req.enrichInstagram) {
        append({ stage: "enriching", message: "Starting Instagram enrichment phase…" });
        const SAFETY_CAP = 300;
        let i = 0;
        while (i++ < SAFETY_CAP) {
          const last = await streamPost("/api/scrape/enrich", { batchSize: 3 });
          if (!last) break;
          if (last.stage === "error") break;
          const remaining = last.counts?.remaining ?? 0;
          if (remaining <= 0) break;
        }
        if (i >= SAFETY_CAP) {
          append({
            stage: "error",
            message: `Hit safety cap (${SAFETY_CAP} batches). Stopping enrichment loop.`,
          });
        }
      }
      append({ stage: "done", message: "Scrape complete." });
    } finally {
      setRunning(false);
    }
  }

  async function runInstagramScrape(req: InstagramScrapeRequest) {
    setEvents([]);
    setRunning(true);
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
        await streamPost("/api/scrape/discover-ig", {
          method: m.method,
          values: m.values,
          skipExisting: req.skipExisting,
          rule: req.rule,
        });
      }
      append({ stage: "done", message: "IG scrape complete." });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      {source === null ? (
        <ScrapeSourcePicker onPick={setSource} />
      ) : source === "google" ? (
        <ScrapeForm
          onSubmit={runGoogleScrape}
          running={running}
          customTerms={initialCustomTerms}
          rule={rule}
          onRuleChange={setRule}
          citiesInDb={citiesInDb}
          onBack={() => {
            setSource(null);
            setEvents([]);
          }}
        />
      ) : (
        <ScrapeFormInstagram
          onSubmit={runInstagramScrape}
          running={running}
          rule={rule}
          onRuleChange={setRule}
          citiesInDb={citiesInDb}
          onBack={() => {
            setSource(null);
            setEvents([]);
          }}
        />
      )}
      <ScrapeProgress events={events} running={running} />
    </>
  );
}
```

**Step 2: Verify build**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npm run build 2>&1 | tail -10
```
Expected: build succeeds.

**Step 3: Commit Phase 3**

```bash
git add components/scrape-source-picker.tsx components/scrape-form-instagram.tsx \
        components/scrape-form.tsx components/scrape-client.tsx
git commit -m "feat(scrape): multi-step form (Source → details) + Instagram form variant"
```

---

## Phase 4 — Verify + ship

### Task 8: Local smoke test (with Igor)

Restart dev:
```bash
pkill -f "next dev"; sleep 1
cd /Users/chartfumonkey/Code/fit-leads-hr && rm -rf .next && npm run dev &
```

In browser:

1. Go to `http://localhost:3000/scrape` → see two cards (Google / Instagram)
2. Click **Google** → existing form appears with "← Back to source picker" link
3. Click Back → returns to picker
4. Click **Instagram** → new form with 4 input fields
5. Enter `vilim.puclin` in **Seed accounts**, leave others empty
6. Configure the qualification rule as desired
7. Click **Run scrape**
8. Watch SSE log: discovering via seed → enriching → filtering for fitness coaches → upserting
9. Visit `/leads` → see new IG-only leads with `place_id` starting `ig:` (visible in detail page) and IG fields populated, phone null

### Task 9: Commit + push

```bash
gh auth switch -u digitalizirajhr && git push && gh auth switch -u ChartFuMonkey
```
Vercel rebuilds. Verify the deployed `/scrape` shows the source picker.

### Task 10: (Optional) Igor adds ANTHROPIC_API_KEY to Vercel

If Igor wants the AI fallback active in prod, add the env var same way as the Supabase ones, then redeploy.

### Task 11: End-to-end Igor verification

Walk through every step from the design doc's Verification plan section. Each numbered step is a checkpoint — pause for "looks good" before next.

---

## Build verification checklist

Before each commit's `git push`:
```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npm run build
```
Build must complete with no type errors.

## Rollback notes

If IG discovery breaks in production but the Google scrape still needs to work:
- Hard option: `git revert` the IG commits, push.
- Soft option: have Igor only ever pick Google in the source picker. The Google flow is unchanged by this feature.

The discovery actors are charged per Apify call. If runs are unexpectedly expensive, lower `MAX_RESULTS_PER_CALL` in `lib/instagram-discovery.ts`.
