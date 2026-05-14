// Instagram lead discovery via HikerAPI. Four methods, all return unique
// lowercased usernames. Used by /api/scrape/discover-ig.
//
// Why HikerAPI not Apify: no actor cold-start, no per-run cost cap, simple
// REST calls. A 1000-following seed scrape finishes in ~5s of wall-clock
// (vs ~90s on the Apify async-poll architecture) and costs ~$0.04.

import {
  fetchFollowings,
  fetchHashtagAuthors,
  fetchLocationAuthors,
  fetchProfile,
  findTopLocationId,
  searchAccounts,
} from "@/lib/hiker";

const MAX_RESULTS_PER_CALL = 5000;

export type DiscoveryMethod = "hashtag" | "location" | "seed" | "bio_keyword";

/** Hashtag scrape → unique post-author usernames. */
export async function discoverByHashtags(
  hashtags: string[],
  apiKey: string,
): Promise<string[]> {
  const cleaned = hashtags.map((h) => h.replace(/^#/, "").trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const out = new Set<string>();
  // Hiker has no multi-hashtag endpoint — paginate each one separately and
  // dedupe in-memory.
  for (const tag of cleaned) {
    const remaining = MAX_RESULTS_PER_CALL - out.size;
    if (remaining <= 0) break;
    const authors = await fetchHashtagAuthors(tag, remaining, apiKey);
    for (const a of authors) out.add(a);
  }
  return Array.from(out);
}

/**
 * Location-name search → unique authors of recent posts at those locations.
 * Two-step: search for the location ID by name (Hiker's /v1/fbsearch/places),
 * then fetch recent posts at that location.
 */
export async function discoverByLocations(
  locationNames: string[],
  apiKey: string,
): Promise<string[]> {
  const cleaned = locationNames.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const out = new Set<string>();
  for (const loc of cleaned) {
    const locId = await findTopLocationId(loc, apiKey);
    if (!locId) continue;
    const remaining = MAX_RESULTS_PER_CALL - out.size;
    if (remaining <= 0) break;
    const authors = await fetchLocationAuthors(locId, remaining, apiKey);
    for (const a of authors) out.add(a);
  }
  return Array.from(out);
}

/**
 * Accounts that the given seeds FOLLOW (not their followers). The intuition:
 * a fitness coach follows other fitness coaches (peers, mentors, friends in
 * the industry); their followers are mostly clients with low lead-gen signal.
 *
 * Hiker's followings endpoint:
 *   - 25 results per page, 2-5s wall-clock per page
 *   - We parallelize 4 pages at a time with a 40s time budget per seed,
 *     so for a typical 1000-follow seed we get 600-800 unique handles
 *     before bailing.
 *   - `partial: true` is surfaced up so the caller can flag the run as
 *     partial in the UI (same UX pattern as the Apify cost-cap salvage).
 *
 * The caller can pass `onProgress` to receive per-batch progress events
 * (used by the SSE route to emit live "Fetched X pages, Y unique handles"
 * messages so the user sees activity instead of a 40s silent stall).
 */
export async function discoverBySeedFollowing(
  seedUsernames: string[],
  apiKey: string,
  opts?: {
    onSeedStart?: (seed: string, followingCount: number | null) => void;
    onPageProgress?: (info: { seed: string; pages: number; uniqueHandles: number; elapsedMs: number }) => void;
    onSeedDone?: (info: { seed: string; partial: boolean; pagesFetched: number; elapsedMs: number; handles: number }) => void;
    timeBudgetMsPerSeed?: number;
  },
): Promise<{ handles: string[]; partial: boolean }> {
  const cleaned = seedUsernames
    .map((u) => u.replace(/^@/, "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return { handles: [], partial: false };
  const out = new Set<string>();
  let anyPartial = false;
  for (const seed of cleaned) {
    const remaining = MAX_RESULTS_PER_CALL - out.size;
    if (remaining <= 0) break;
    const profile = await fetchProfile(seed, apiKey);
    opts?.onSeedStart?.(seed, profile?.following ?? null);
    if (!profile || !profile.userId) continue;
    const result = await fetchFollowings(profile.userId, remaining, apiKey, {
      timeBudgetMs: opts?.timeBudgetMsPerSeed,
      onProgress: (info) =>
        opts?.onPageProgress?.({ seed, ...info }),
    });
    for (const f of result.handles) out.add(f);
    if (result.partial) anyPartial = true;
    opts?.onSeedDone?.({
      seed,
      partial: result.partial,
      pagesFetched: result.pagesFetched,
      elapsedMs: result.elapsedMs,
      handles: result.handles.length,
    });
  }
  return { handles: Array.from(out), partial: anyPartial };
}

/**
 * Bio/user keyword search → matching usernames. Maps to Hiker's
 * /v2/fbsearch/accounts which matches usernames, full names, and parts of
 * bios — same surface IG's own search bar exposes.
 */
export async function discoverByBioKeywords(
  keywords: string[],
  apiKey: string,
): Promise<string[]> {
  const cleaned = keywords.map((k) => k.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  // One search per keyword, dedupe across all results. Matches the way Igor
  // already enters them in the form (comma-separated).
  const out = new Set<string>();
  for (const term of cleaned) {
    const handles = await searchAccounts(term, apiKey);
    for (const h of handles) out.add(h);
  }
  return Array.from(out);
}

/**
 * Dispatcher: one method, one set of values → handles. Returns `partial: true`
 * when the time budget was hit before the upstream API ran out (so the route
 * can flag the run with a PARTIAL warning in the SSE log).
 *
 * `progress` callback fires for seed-method during pagination so the SSE
 * route can emit live "fetched X pages so far" events.
 */
export type DiscoveryProgress =
  | { kind: "seed-start"; seed: string; followingCount: number | null }
  | { kind: "seed-page"; seed: string; pages: number; uniqueHandles: number; elapsedMs: number }
  | { kind: "seed-done"; seed: string; partial: boolean; pagesFetched: number; elapsedMs: number; handles: number };

export async function discoverHandles(
  method: DiscoveryMethod,
  values: string[],
  apiKey: string,
  onProgress?: (event: DiscoveryProgress) => void,
): Promise<{ handles: string[]; partial: boolean }> {
  switch (method) {
    case "hashtag":
      return { handles: await discoverByHashtags(values, apiKey), partial: false };
    case "location":
      return { handles: await discoverByLocations(values, apiKey), partial: false };
    case "seed":
      return discoverBySeedFollowing(values, apiKey, {
        onSeedStart: (seed, followingCount) =>
          onProgress?.({ kind: "seed-start", seed, followingCount }),
        onPageProgress: (info) => onProgress?.({ kind: "seed-page", ...info }),
        onSeedDone: (info) => onProgress?.({ kind: "seed-done", ...info }),
      });
    case "bio_keyword":
      return { handles: await discoverByBioKeywords(values, apiKey), partial: false };
  }
}
