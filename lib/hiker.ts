// HikerAPI client. Replaces our previous Apify-based IG scraping with a
// purpose-built REST API — no actor cold-start (~5-10s tax per Apify call),
// no async-poll dance, no per-run cost caps. Auth: x-access-key header.
//
// Pricing on Igor's STANDARD plan: $0.001 per request. A typical seed scrape
// (~750 followings) consumes ~790 requests = $0.79. Compare to Apify where
// the same scrape was $1-2 + 60s cold-start tax.
//
// Endpoints we use (verified against api.hikerapi.com OpenAPI spec 2026-05):
//   /v2/user/by/username           — single profile lookup (enrichment)
//   /g2/user/following             — paginated followings list (seed method)
//   /v2/fbsearch/accounts          — username/bio keyword search (bio_keyword)
//   /v2/hashtag/medias/recent      — recent posts for a hashtag (hashtag method)
//   /v1/fbsearch/places            — search for locations by name (location step 1)
//   /v1/location/medias/recent/chunk — posts at a location (location step 2)

const BASE = "https://api.hikerapi.com";

// Per Hiker's docs, pagination cursors come back as either `next_page_id`
// or `next_max_id` depending on the endpoint. We normalize when we read.
interface PagedResponse<T> {
  response?: { users?: T[]; items?: T[] };
  users?: T[];
  items?: T[];
  next_page_id?: string;
  next_max_id?: string;
}

// Raw profile shape from /v2/user/by/username's `user` field. Hiker mirrors
// IG's internal naming (snake_case, lots of fields we don't care about).
interface HikerRawProfile {
  username?: string;
  pk?: number | string;
  follower_count?: number;
  following_count?: number;
  biography?: string;
  is_private?: boolean;
  is_business?: boolean;
  media_count?: number;
  /** Unix seconds of the most-recent reel — used as our "active in 30 days"
   *  proxy. Hiker doesn't expose a separate "latest post" timestamp on the
   *  cheap profile endpoint, but reels are how creators actually post on IG. */
  latest_reel_media?: number;
}

/** Narrowed shape we return to callers. */
export interface HikerProfile {
  username: string;
  userId: string; // numeric IG id, stringified
  followers: number | null;
  following: number | null;
  bio: string | null;
  isPrivate: boolean;
  isBusiness: boolean;
  mediaCount: number;
  /** Unix seconds — null if profile has no reels. */
  latestReelTs: number | null;
}

function mapProfile(raw: HikerRawProfile | undefined | null): HikerProfile | null {
  if (!raw || !raw.username) return null;
  return {
    username: raw.username.toLowerCase(),
    userId: raw.pk != null ? String(raw.pk) : "",
    followers: raw.follower_count ?? null,
    following: raw.following_count ?? null,
    bio: raw.biography ?? null,
    isPrivate: raw.is_private ?? false,
    isBusiness: raw.is_business ?? false,
    mediaCount: raw.media_count ?? 0,
    latestReelTs: raw.latest_reel_media ?? null,
  };
}

/** Custom error so callers can distinguish 404 (user gone) from network/quota issues. */
export class HikerNotFoundError extends Error {
  constructor(public username: string) {
    super(`HikerAPI 404: user not found (${username})`);
    this.name = "HikerNotFoundError";
  }
}

async function get<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = `${BASE}${path}?${qs.toString()}`;
  const res = await fetch(url, {
    headers: { "x-access-key": apiKey },
    cache: "no-store",
  });
  if (res.status === 404) {
    // Caller decides how to surface this — for username lookups we throw
    // HikerNotFoundError; for paged endpoints we just return empty.
    const text = await res.text().catch(() => "");
    throw new Error(`HikerAPI 404 ${path}: ${text || res.statusText}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HikerAPI ${res.status} ${path}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Look up a single profile by username. Returns null on 404. Other errors
 * (auth, quota, network) throw so the caller can surface them.
 */
export async function fetchProfile(
  username: string,
  apiKey: string,
): Promise<HikerProfile | null> {
  try {
    const data = await get<{ user?: HikerRawProfile }>(
      "/v2/user/by/username",
      { username },
      apiKey,
    );
    return mapProfile(data.user);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("HikerAPI 404")) return null;
    throw err;
  }
}

/**
 * Paginated followings list. Returns unique lowercased usernames the given
 * `userId` is following, capped at `maxCount`. Pagination via `next_page_id`.
 *
 * Each page returns ~25 users at $0.001/page — so for a 1000-following seed
 * we burn ~40 requests = $0.04. The userId you pass must be the numeric IG
 * pk, obtained from fetchProfile first.
 */
export async function fetchFollowings(
  userId: string,
  maxCount: number,
  apiKey: string,
): Promise<string[]> {
  const out = new Set<string>();
  let pageId: string | undefined;
  let safetyPages = 0;
  while (out.size < maxCount && safetyPages++ < 2000) {
    const resp = await get<PagedResponse<{ username?: string }>>(
      "/g2/user/following",
      { user_id: userId, page_id: pageId },
      apiKey,
    );
    const users = resp.response?.users ?? resp.users ?? [];
    for (const u of users) {
      if (u.username) out.add(u.username.toLowerCase());
      if (out.size >= maxCount) break;
    }
    pageId = resp.next_page_id ?? resp.next_max_id;
    if (!pageId || users.length === 0) break;
  }
  return Array.from(out);
}

/**
 * Search for accounts matching a query string. Maps to IG's account-search
 * box behavior — matches against usernames AND full names (and some bio).
 * Single request, no pagination on this endpoint.
 */
export async function searchAccounts(
  query: string,
  apiKey: string,
): Promise<string[]> {
  const resp = await get<{
    users?: Array<{ username?: string }>;
    response?: { users?: Array<{ username?: string }> };
  }>("/v2/fbsearch/accounts", { query }, apiKey);
  const users = resp.users ?? resp.response?.users ?? [];
  return Array.from(
    new Set(
      users
        .map((u) => u.username?.toLowerCase())
        .filter((u): u is string => Boolean(u)),
    ),
  );
}

/**
 * Recent posts under a hashtag. Returns unique lowercased post-author
 * usernames, capped at `maxCount`. Paginated.
 */
export async function fetchHashtagAuthors(
  hashtag: string,
  maxCount: number,
  apiKey: string,
): Promise<string[]> {
  const name = hashtag.replace(/^#/, "").trim();
  if (!name) return [];
  const out = new Set<string>();
  let pageId: string | undefined;
  let safetyPages = 0;
  while (out.size < maxCount && safetyPages++ < 2000) {
    const resp = await get<
      PagedResponse<{ user?: { username?: string }; owner?: { username?: string } }>
    >(
      "/v2/hashtag/medias/recent",
      { name, page_id: pageId },
      apiKey,
    );
    const items = resp.response?.items ?? resp.items ?? [];
    for (const item of items) {
      const handle = item.user?.username ?? item.owner?.username;
      if (handle) out.add(handle.toLowerCase());
      if (out.size >= maxCount) break;
    }
    pageId = resp.next_page_id ?? resp.next_max_id;
    if (!pageId || items.length === 0) break;
  }
  return Array.from(out);
}

/**
 * Search for IG location IDs matching a query (e.g., "Zagreb"). Returns the
 * top match's place id, or null. Used as step 1 of location discovery
 * before fetchLocationAuthors.
 */
export async function findTopLocationId(
  query: string,
  apiKey: string,
): Promise<string | null> {
  try {
    const resp = await get<{
      places?: Array<{ location?: { pk?: string | number; name?: string } }>;
    }>("/v1/fbsearch/places", { query }, apiKey);
    const top = resp.places?.[0]?.location;
    if (!top?.pk) return null;
    return String(top.pk);
  } catch {
    return null;
  }
}

/**
 * Recent posts at a given location id. Returns unique lowercased
 * post-author usernames, capped at `maxCount`. Paginated.
 */
export async function fetchLocationAuthors(
  locationId: string,
  maxCount: number,
  apiKey: string,
): Promise<string[]> {
  const out = new Set<string>();
  let pageId: string | undefined;
  let safetyPages = 0;
  while (out.size < maxCount && safetyPages++ < 2000) {
    const resp = await get<
      PagedResponse<{ user?: { username?: string }; owner?: { username?: string } }>
    >(
      "/v1/location/medias/recent/chunk",
      { location_id: locationId, page_id: pageId },
      apiKey,
    );
    const items = resp.response?.items ?? resp.items ?? [];
    for (const item of items) {
      const handle = item.user?.username ?? item.owner?.username;
      if (handle) out.add(handle.toLowerCase());
      if (out.size >= maxCount) break;
    }
    pageId = resp.next_page_id ?? resp.next_max_id;
    if (!pageId || items.length === 0) break;
  }
  return Array.from(out);
}
