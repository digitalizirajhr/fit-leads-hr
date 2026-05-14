// Wrappers around the 4 Apify discovery actors used by /api/scrape/discover-ig.
// Each returns a list of unique IG handles (lowercased). Results capped per
// call so each chunk fits Vercel's 60s timeout.

const MAX_RESULTS_PER_CALL = 100;

const HASHTAG_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items";
const SEARCH_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items";
const FOLLOWERS_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-follower-scraper/run-sync-get-dataset-items";

export type DiscoveryMethod = "hashtag" | "location" | "seed" | "bio_keyword";

interface ApifyPost {
  ownerUsername?: string;
}
interface ApifyUser {
  username?: string;
}
interface ApifyFollower {
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

/** Location-name search → unique authors of recent posts at those locations. */
export async function discoverByLocations(
  locationNames: string[],
  apifyToken: string,
): Promise<string[]> {
  const cleaned = locationNames.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const url = `${SEARCH_ENDPOINT}?token=${apifyToken}`;
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
  const cleaned = seedUsernames
    .map((u) => u.replace(/^@/, "").trim())
    .filter(Boolean);
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
    case "hashtag":
      return discoverByHashtags(values, apifyToken);
    case "location":
      return discoverByLocations(values, apifyToken);
    case "seed":
      return discoverBySeedFollowers(values, apifyToken);
    case "bio_keyword":
      return discoverByBioKeywords(values, apifyToken);
  }
}
