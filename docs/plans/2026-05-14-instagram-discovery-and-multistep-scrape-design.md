# Instagram Discovery + Multi-Step Scrape Form — Design

**Date:** 2026-05-14
**Status:** approved (Igor: "all good, build it")

## Goal

Two intertwined additions:

1. **Discover individual fitness coaches on Instagram**, not just gyms on Google. Many Croatian personal trainers exist only on IG — they're invisible to the Google Places pipeline.
2. **Restructure /scrape as a multi-step form**: pick source (Google or Instagram) → fill out source-specific details. The current single-page form is getting busy and the two sources have very different inputs.

## Why both at once

The IG discovery pipeline needs new UI (hashtag/location/seed/keyword inputs). Adding it inline to the existing form would make /scrape unreasonably long. A two-step source-picker is the natural way to split.

## UX

### Step 1 — Source picker

Two cards. Single-choice.

```
┌────────────────────────────┐  ┌────────────────────────────┐
│  Google Business           │  │  Instagram                 │
│                            │  │                            │
│  Gyms, fitness studios     │  │  Individual personal       │
│  with phones from Google.  │  │  trainers via hashtag,     │
│  Best for established      │  │  location, seed accounts,  │
│  businesses.               │  │  or bio keyword search.    │
└────────────────────────────┘  └────────────────────────────┘
```

### Step 2a — Google form (if Google chosen)

Existing form, no changes other than adding a top-left "← Back" link.

- Cities checkbox grid
- Search terms grid + custom-terms manager
- Skip existing toggle
- Also enrich with Instagram toggle
- Qualification criteria (8 toggles)
- Run scrape

### Step 2b — Instagram form (if Instagram chosen)

New form.

- ← Back link
- **Hashtags** input — comma-separated, e.g. `personalnitrenerzagreb, fitnesstrenerhrvatska`
- **Locations** input — comma-separated location names (resolved via Apify)
- **Seed accounts** input — comma-separated usernames, e.g. `iyaprivanovic, vilim.puclin`
- **Bio keyword search** input — comma-separated keywords, e.g. `kineziolog zagreb`
- *Note:* empty fields are skipped — pick whichever methods you want
- Skip existing toggle
- Qualification criteria (same panel; "has phone" criterion will rarely match for IG-only leads — that's the user's call)
- Run scrape

### State

Local React state (no URL persistence). Going Back resets the source-specific form. Matches the "oneshot per scrape" mental model already in use.

## Pipeline (server-side)

### Google chunk (existing)

Unchanged. One POST per (city × term) with rule in the body. `/api/scrape`.

### Instagram chunk (new)

Per-method POSTs to `/api/scrape/discover-ig` (new endpoint). Body:

```ts
{
  method: "hashtag" | "location" | "seed" | "bio_keyword",
  values: string[],          // e.g. ["personalnitrenerzagreb"] or ["iyaprivanovic"]
  rule: QualificationRule,   // same per-scrape rule shape
  skipExisting: boolean
}
```

For each request:

```
1. DISCOVER candidates → list of IG handles
   Method routing:
     hashtag      → apify/instagram-hashtag-scraper       (extract post.ownerUsername)
     location     → apify/instagram-search-scraper        (location mode)
     seed         → apify/instagram-followers-scraper     (followers + following of each seed)
     bio_keyword  → apify/instagram-search-scraper        (user mode)

   Cap each Apify call's resultsLimit so each chunk fits Vercel's 60s timeout
   (e.g. 100 results per call).

2. DEDUPE in-memory (lowercase compare)

3. SKIP-EXISTING in DB:
   - leads where instagram_handle IN (...) OR place_id IN ("ig:HANDLE", ...)

4. ENRICH each surviving handle via existing enrichBatch from lib/instagram.ts
   (apify/instagram-profile-scraper, batch size 5-10)

5. KEYWORD FILTER on bio:
   COACH_KEYWORDS = ["trener", "trenerica", "coach", "fitness", "kineziolog",
                     "personalni trener", "bodybuilder", "sportaš", "sportašica",
                     "powerlifting", "yoga", "pilates", "crossfit"]
   Lowercase substring match against bio. Profiles passing → keep.

6. AI FALLBACK for profiles that FAILED step 5:
   For each, call Claude Haiku with prompt:
     "This is an Instagram bio: {bio}. Is this person a fitness/sports
      professional in Croatia (trainer, coach, kinesiologist, athlete)?
      Reply only YES or NO."
   YES → keep. NO → drop.

   Skipped if no ANTHROPIC_API_KEY env var (graceful fallback to keyword-only).

7. UPSERT survivors into `leads`:
   - place_id = "ig:" + handle.toLowerCase()
   - name = profile.fullName || profile.username
   - phone = null
   - current_website = "https://instagram.com/" + handle
   - city = null  (Igor can derive manually or via future enhancement)
   - has_real_website = false
   - qualified = computeQualified(row, rule)  -- shared helper, same as Google chunk
   - instagram_handle, instagram_followers, instagram_bio,
     instagram_last_post_at, instagram_is_active = from enrichment

   Upsert by place_id. Same onConflict pattern as Google chunk preserves any
   user-edited CRM fields (status, priority, notes, override).
```

### SSE event shape

Same `ScrapeEvent` type. Add optional `method` field for IG chunks (so the UI can label "[hashtag] Searching personalnitrenerzagreb…").

## Data model

**No schema changes.** The `leads` table already has every needed column. Synthetic `place_id` works because the column is just a unique text constraint — nothing parses it as a Google Place ID.

## New env var

- `ANTHROPIC_API_KEY` — Claude Haiku for the bio-classifier fallback. Optional: pipeline still works (degraded — keyword-only) if missing.

## File-level impact

**New:**
- `lib/instagram-discovery.ts` — wrappers per Apify discovery actor (hashtag, location, followers, search)
- `lib/coach-classifier.ts` — keyword filter + AI fallback (calls Claude Haiku)
- `app/api/scrape/discover-ig/route.ts` — chunked endpoint that runs the pipeline above
- `components/scrape-source-picker.tsx` — Step 1 of the multi-step form
- `components/scrape-form-instagram.tsx` — Step 2b form
- (existing `components/scrape-form.tsx` becomes Step 2a, mostly renamed/moved)

**Modified:**
- `components/scrape-client.tsx` — owns the multi-step state, orchestrates either Google chunks (existing) or IG chunks (new)
- `app/scrape/page.tsx` — server-fetch nothing extra (custom_terms still); render the new orchestrator

**No changes:**
- `lib/instagram.ts` (existing enrichBatch is reused)
- `lib/qualification.ts` (computeQualified is shared)
- DB schema, /api/scrape/enrich, /leads, /leads/[id], etc.

## Cost guardrails

- Each Apify call's `resultsLimit` capped to keep individual requests under 60s
- Skip-existing dedupe BEFORE enrichment so we don't re-bill profile-scraper
- AI fallback only runs on profiles that fail keyword filter (typically 5-15% of total)
- Hard cap: 1000 candidate handles per discovery call (defense against runaway hashtag returns)

Typical full-Croatia IG run cost (5 hashtags + 5 locations + 5 seeds + 3 bio queries):
- Hashtag scraper: ~$1.50
- Location scraper: ~$0.50
- Followers scraper: ~$2.00
- Search scraper: ~$0.60
- Profile-scraper enrichment (~300 unique handles): ~$0.50
- AI classifier (~30 ambiguous bios): ~$0.01
- **Total: ~$5.00** — within budget

## Out of scope

- City inference from hashtag name (e.g. `#fitnesszagreb` → "Zagreb"). Igor adds city manually for IG leads in v1.
- Auto-translation of Croatian bios for the AI classifier — Claude Haiku handles Croatian directly.
- Smart deduping across sources (Google's `iyaprivanovic gym` vs IG's `@iyaprivanovic`). Different `place_id` prefix means duplicates may exist; Igor handles via manual review.
- Caching Apify results across runs (would save $ on re-runs but adds DB complexity).
- Per-method qualification (e.g. different rule for hashtag-discovered vs location-discovered).

## Verification plan

1. Local: pick Instagram source → enter one hashtag (`fitnesstrenerzagreb`) → run → see SSE events showing hashtag scrape + enrichment + keyword filter + AI fallback (if key set) + upserts.
2. Confirm leads land with `place_id = "ig:HANDLE"` and proper IG fields populated.
3. Confirm `qualified` reflects the rule's IG criteria.
4. Re-run same hashtag with skipExisting=on → 0 new (idempotent).
5. Test seed accounts: enter your own IG `vilim.puclin` → see followers discovered.
6. Test bio_keyword: enter `kineziolog zagreb` → see search results filtered.
7. Test wrong-domain rejection still works (no regression on auth).
8. Test Google source still works end-to-end (no regression on existing chunked Google scrape).
9. Push to prod, repeat #1 + #8 on Vercel.
