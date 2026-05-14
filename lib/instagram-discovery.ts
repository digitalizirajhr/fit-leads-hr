// Wrappers around the Apify discovery actors used by /api/scrape/discover-ig.
// Each returns a list of unique IG handles (lowercased). Results capped per
// call so each chunk fits Vercel's 60s timeout.
//
// Actor IDs verified against https://apify.com/store on 2026-05-14:
//   - apify/instagram-hashtag-scraper      (official)
//   - apify/instagram-scraper              (official, multi-purpose)
//   - coderx/instagram-followers-following-scraper-no-cookies-login (community,
//     free tier — scrapes who a profile FOLLOWS. We use "following" not
//     "followers" because a coach's peers are who THEY follow; their followers
//     are mostly clients with low lead-gen signal. Tried louisdeconinck's
//     equivalent first but it returned "Free users need cookies" without
//     a paid Apify plan.)

const MAX_RESULTS_PER_CALL = 100;

const HASHTAG_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items";
const GENERIC_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items";
const FOLLOWING_ENDPOINT =
  "https://api.apify.com/v2/acts/coderx~instagram-followers-following-scraper-no-cookies-login/run-sync-get-dataset-items";

export type DiscoveryMethod = "hashtag" | "location" | "seed" | "bio_keyword";

interface ApifyPost {
  ownerUsername?: string;
}
interface ApifyUser {
  username?: string;
}
interface ApifyFollowedAccount {
  username?: string;
}

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

/**
 * Location-name search → unique authors of recent posts at those locations.
 * Uses apify/instagram-scraper's "search → place → posts" flow. Each location
 * name resolves to its top match on Instagram.
 */
export async function discoverByLocations(
  locationNames: string[],
  apifyToken: string,
): Promise<string[]> {
  const cleaned = locationNames.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const url = `${GENERIC_ENDPOINT}?token=${apifyToken}`;
  // Run search-by-place for each location, dedupe across all of them.
  const all: string[] = [];
  for (const loc of cleaned) {
    const items = await postJson<ApifyPost[]>(url, {
      search: loc,
      searchType: "place",
      resultsType: "posts",
      searchLimit: 1, // top matching place
      resultsLimit: MAX_RESULTS_PER_CALL,
    });
    for (const p of items) if (p.ownerUsername) all.push(p.ownerUsername);
  }
  return uniqueLower(all);
}

/**
 * Accounts that the given seeds FOLLOW (not their followers). The intuition:
 * a fitness coach follows other fitness coaches (peers, mentors, friends in
 * the industry); their followers are mostly clients with low lead-gen signal.
 *
 * The coderx actor takes ONE username per run, so we loop through the seeds
 * and dedupe across all of them.
 */
export async function discoverBySeedFollowing(
  seedUsernames: string[],
  apifyToken: string,
): Promise<string[]> {
  const cleaned = seedUsernames
    .map((u) => u.replace(/^@/, "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return [];
  const url = `${FOLLOWING_ENDPOINT}?token=${apifyToken}`;
  const all: string[] = [];
  for (const seed of cleaned) {
    const items = await postJson<ApifyFollowedAccount[]>(url, {
      username: seed,
      type: "following",
      resultsLimit: MAX_RESULTS_PER_CALL,
    });
    for (const f of items) if (f.username) all.push(f.username);
  }
  return uniqueLower(all);
}

/**
 * Bio/user keyword search → matching usernames. Uses apify/instagram-scraper's
 * "search → user → details" flow. The keywords are joined into a single
 * search query (matches IG's own search-bar behavior).
 */
export async function discoverByBioKeywords(
  keywords: string[],
  apifyToken: string,
): Promise<string[]> {
  const cleaned = keywords.map((k) => k.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const url = `${GENERIC_ENDPOINT}?token=${apifyToken}`;
  const items = await postJson<ApifyUser[]>(url, {
    search: cleaned.join(" "),
    searchType: "user",
    resultsType: "details",
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
    case "hashtag":
      return discoverByHashtags(values, apifyToken);
    case "location":
      return discoverByLocations(values, apifyToken);
    case "seed":
      return discoverBySeedFollowing(values, apifyToken);
    case "bio_keyword":
      return discoverByBioKeywords(values, apifyToken);
  }
}
