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
 * Hiker's followings endpoint takes a numeric user ID, so each seed needs a
 * profile lookup first to get its `pk`. Two requests per seed plus N pages.
 */
export async function discoverBySeedFollowing(
  seedUsernames: string[],
  apiKey: string,
): Promise<string[]> {
  const cleaned = seedUsernames
    .map((u) => u.replace(/^@/, "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return [];
  const out = new Set<string>();
  for (const seed of cleaned) {
    const remaining = MAX_RESULTS_PER_CALL - out.size;
    if (remaining <= 0) break;
    const profile = await fetchProfile(seed, apiKey);
    if (!profile || !profile.userId) continue;
    const followings = await fetchFollowings(profile.userId, remaining, apiKey);
    for (const f of followings) out.add(f);
  }
  return Array.from(out);
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

/** Dispatcher: one method, one set of values → handles. */
export async function discoverHandles(
  method: DiscoveryMethod,
  values: string[],
  apiKey: string,
): Promise<string[]> {
  switch (method) {
    case "hashtag":
      return discoverByHashtags(values, apiKey);
    case "location":
      return discoverByLocations(values, apiKey);
    case "seed":
      return discoverBySeedFollowing(values, apiKey);
    case "bio_keyword":
      return discoverByBioKeywords(values, apiKey);
  }
}
