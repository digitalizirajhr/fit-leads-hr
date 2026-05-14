// Wrappers around the Apify discovery actors used by /api/scrape/discover-ig.
// Each returns a list of unique IG handles (lowercased). Results capped per
// call so each chunk fits Vercel's 60s timeout.
//
// Actor IDs verified against https://apify.com/store on 2026-05-14:
//   - apify/instagram-hashtag-scraper      (official)
//   - apify/instagram-scraper              (official, multi-purpose)
//   - datadoping/instagram-following-scraper (community, no daily quota,
//     ~$0.00155 per result. Tried louisdeconinck's first — needed paid plan;
//     coderx's was rate-limited to 1 free run per day. datadoping returns
//     `following_of` field that confirms it's actually following data.)

const MAX_RESULTS_PER_CALL = 5000;

const HASHTAG_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items";
const GENERIC_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items";
const FOLLOWING_ENDPOINT =
  "https://api.apify.com/v2/acts/datadoping~instagram-following-scraper/run-sync-get-dataset-items";

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
 * The datadoping actor accepts an array of usernames and a `max_count` cap.
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
  const items = await postJson<ApifyFollowedAccount[]>(url, {
    usernames: cleaned,
    max_count: MAX_RESULTS_PER_CALL,
  });
  return uniqueLower(items.map((f) => f.username));
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

// ---------------------------------------------------------------------------
// Async / polling API
// ---------------------------------------------------------------------------
//
// For seeds with hundreds of followings (e.g. fitness_byiva @ 603), the
// run-sync-get-dataset-items call takes 90+ seconds and blows past Vercel's
// 60s function timeout. To work around this, we start the Apify run with the
// async API, then poll its status in separate Vercel calls. Once the actor
// finishes (status=SUCCEEDED), we fetch the dataset items and process them.
//
// One consequence: each method's actor + input format must be encoded once
// for the start step, and once when extracting handles from the dataset
// items. METHOD_ACTOR_CONFIG below carries both.

interface MethodConfig {
  /** Apify actor id like "apify~instagram-hashtag-scraper". */
  actorId: string;
  /** Build the Apify actor input from the user's `values` array. */
  buildInput: (values: string[]) => object;
  /** Extract the username field from one dataset item. Different actors emit
   *  different shapes — hashtag returns posts with ownerUsername, search
   *  returns users with username, etc. */
  extractUsername: (item: unknown) => string | undefined;
}

const METHOD_ACTOR_CONFIG: Record<DiscoveryMethod, MethodConfig> = {
  hashtag: {
    actorId: "apify~instagram-hashtag-scraper",
    buildInput: (values) => ({
      hashtags: values.map((h) => h.replace(/^#/, "").trim()).filter(Boolean),
      resultsLimit: MAX_RESULTS_PER_CALL,
    }),
    extractUsername: (item) => (item as ApifyPost)?.ownerUsername,
  },
  location: {
    actorId: "apify~instagram-scraper",
    buildInput: (values) => ({
      search: values.map((v) => v.trim()).filter(Boolean).join(","),
      searchType: "place",
      resultsType: "posts",
      searchLimit: 1,
      resultsLimit: MAX_RESULTS_PER_CALL,
    }),
    extractUsername: (item) => (item as ApifyPost)?.ownerUsername,
  },
  seed: {
    actorId: "datadoping~instagram-following-scraper",
    buildInput: (values) => ({
      usernames: values.map((u) => u.replace(/^@/, "").trim()).filter(Boolean),
      max_count: MAX_RESULTS_PER_CALL,
    }),
    extractUsername: (item) => (item as ApifyFollowedAccount)?.username,
  },
  bio_keyword: {
    actorId: "apify~instagram-scraper",
    buildInput: (values) => ({
      search: values.map((k) => k.trim()).filter(Boolean).join(" "),
      searchType: "user",
      resultsType: "details",
      resultsLimit: MAX_RESULTS_PER_CALL,
    }),
    extractUsername: (item) => (item as ApifyUser)?.username,
  },
};

export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "ABORTING"
  | "ABORTED"
  | "TIMING-OUT"
  | "TIMED-OUT";

interface ApifyRun {
  id: string;
  status: ApifyRunStatus;
  defaultDatasetId: string;
  statusMessage?: string;
}

/**
 * Start an Apify run for the given method asynchronously. Returns immediately
 * with the run id — the caller polls separately.
 */
export async function startDiscoveryRun(
  method: DiscoveryMethod,
  values: string[],
  apifyToken: string,
): Promise<{ apifyRunId: string }> {
  const cfg = METHOD_ACTOR_CONFIG[method];
  const url = `https://api.apify.com/v2/acts/${cfg.actorId}/runs?token=${apifyToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg.buildInput(values)),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify start ${res.status}: ${text || res.statusText}`);
  }
  const json = (await res.json()) as { data: ApifyRun };
  return { apifyRunId: json.data.id };
}

/** Get the current status of a previously started Apify run. */
export async function getDiscoveryRun(
  apifyRunId: string,
  apifyToken: string,
): Promise<ApifyRun> {
  const url = `https://api.apify.com/v2/actor-runs/${apifyRunId}?token=${apifyToken}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify status ${res.status}: ${text || res.statusText}`);
  }
  const json = (await res.json()) as { data: ApifyRun };
  return json.data;
}

/**
 * Once an Apify run reaches SUCCEEDED, fetch its dataset items and extract
 * unique handles using the per-method shape mapper.
 */
export async function fetchDiscoveryHandles(
  method: DiscoveryMethod,
  datasetId: string,
  apifyToken: string,
): Promise<string[]> {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&limit=10000`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify dataset ${res.status}: ${text || res.statusText}`);
  }
  const items = (await res.json()) as unknown[];
  const cfg = METHOD_ACTOR_CONFIG[method];
  return uniqueLower(items.map((i) => cfg.extractUsername(i)));
}
