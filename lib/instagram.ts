// Instagram profile enrichment.
//
// We used to call Apify's `apify/instagram-profile-scraper` here, but the
// 5-10s cold-start tax per call made enrichment painfully slow even with
// async-polling. We now use HikerAPI (REST, no cold-start, ~200ms/req).
//
// Pricing on Igor's STANDARD HikerAPI plan: $0.001 per profile. Negligible
// for our scale.

import { fetchProfile, type HikerProfile } from "@/lib/hiker";

// 30 days ago, in ms — used to compute instagram_is_active.
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RESERVED_PATHS = new Set([
  "about",
  "accounts",
  "direct",
  "explore",
  "p",
  "reel",
  "reels",
  "stories",
  "tv",
]);

/** Pull a handle out of a URL like "https://instagram.com/celikovic/". */
export function extractHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "instagram.com" && host !== "www.instagram.com") return null;
  const [first] = parsed.pathname.split("/").filter(Boolean);
  if (!first) return null;
  // Strip trailing punctuation that the regex might catch (a stray dot, etc).
  const handle = first.replace(/[._]+$/, "").toLowerCase();
  if (!handle || RESERVED_PATHS.has(handle)) return null;
  if (!/^[a-z0-9._]{1,30}$/.test(handle)) return null;
  return handle;
}

/** Shape of one profile we return up the stack — narrowed from HikerAPI's much wider schema. */
export interface EnrichedProfile {
  handle: string;
  followers: number | null;
  bio: string | null;
  latestPostAt: string | null; // ISO timestamp or null
  isActive: boolean; // posted within ACTIVE_WINDOW_MS
}

function mapHikerToEnriched(p: HikerProfile): EnrichedProfile {
  // Hiker's `latest_reel_media` is Unix seconds. It only tracks reels, not
  // regular grid posts — but in practice creators post reels regularly, so
  // it's a reasonable proxy for "is this account active right now."
  let latestPostAt: string | null = null;
  let isActive = false;
  if (p.latestReelTs && p.latestReelTs > 0) {
    const ms = p.latestReelTs * 1000;
    latestPostAt = new Date(ms).toISOString();
    isActive = Date.now() - ms <= ACTIVE_WINDOW_MS;
  }
  return {
    handle: p.username.toLowerCase(),
    followers: p.followers,
    bio: p.bio,
    latestPostAt,
    isActive,
  };
}

/**
 * Enrich a single handle. Returns null on 404 / private / deleted.
 * Throws on auth/network/quota errors so callers see them.
 */
export async function enrichOne(
  handle: string,
  apiKey: string,
): Promise<EnrichedProfile | null> {
  const profile = await fetchProfile(handle, apiKey);
  if (!profile) return null;
  return mapHikerToEnriched(profile);
}

/**
 * Enrich a list of handles. HikerAPI's profile endpoint is one-at-a-time
 * but fast (~200ms each), so we run with bounded concurrency: 10 in flight
 * is well under Hiker's rate limit and finishes a batch of 50 in ~1.5s.
 *
 * Returns a Map<handle (lowercased), profile>. Handles that 404 (private,
 * deleted, mistyped) are simply absent from the map — same contract as
 * the previous Apify-backed version, so callers don't need to change.
 */
export async function enrichAll(
  handles: string[],
  apiKey: string,
): Promise<Map<string, EnrichedProfile>> {
  // Dedupe + lowercase up front so we never bill twice for the same profile.
  const unique = Array.from(new Set(handles.map((h) => h.toLowerCase()).filter(Boolean)));
  const out = new Map<string, EnrichedProfile>();

  const CONCURRENCY = 10;
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const i = cursor++;
      const handle = unique[i];
      try {
        const profile = await enrichOne(handle, apiKey);
        if (profile) out.set(profile.handle, profile);
      } catch {
        // Per-handle network/quota errors: skip silently. The handle stays
        // absent from `out`, which is the same "unreachable" signal as a 404.
        // We don't want one flaky request to abort the whole batch.
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return out;
}
