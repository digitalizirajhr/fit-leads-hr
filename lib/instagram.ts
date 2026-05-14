// Instagram enrichment via Apify's `apify/instagram-profile-scraper`.
//
// Pricing: ~$1.60 per 1000 profiles (~$0.0016 each). Negligible for our scale.
//
// We use the `run-sync-get-dataset-items` endpoint which is convenient (one
// HTTP call gets you the results) but synchronous — the response can take
// minutes for large batches. Batch size is capped at 50 per spec to keep
// each call under a couple of minutes.

const ENDPOINT =
  "https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items";

const BATCH_SIZE = 50;

// 30 days ago, in ms — used to compute instagram_is_active.
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Pull a handle out of a URL like "https://instagram.com/celikovic/". */
export function extractHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/instagram\.com\/([a-zA-Z0-9_.]+)/i);
  if (!m) return null;
  // Strip trailing punctuation that the regex might catch (a stray dot, etc).
  return m[1].replace(/[._]+$/, "").toLowerCase();
}

/** Shape of one profile we return up the stack — narrowed from Apify's much wider schema. */
export interface EnrichedProfile {
  handle: string;
  followers: number | null;
  bio: string | null;
  latestPostAt: string | null; // ISO timestamp or null
  isActive: boolean; // posted within ACTIVE_WINDOW_MS
}

// Apify's profile-scraper response is an array of objects with this shape
// (we type only the fields we read).
interface ApifyProfile {
  username?: string;
  followersCount?: number;
  biography?: string;
  latestPosts?: Array<{ timestamp?: string }>;
}

function mapProfile(p: ApifyProfile): EnrichedProfile | null {
  if (!p.username) return null;

  const latestRaw = p.latestPosts?.[0]?.timestamp ?? null;
  let isActive = false;
  if (latestRaw) {
    const then = new Date(latestRaw).getTime();
    if (!Number.isNaN(then)) {
      isActive = Date.now() - then <= ACTIVE_WINDOW_MS;
    }
  }

  return {
    handle: p.username.toLowerCase(),
    followers: p.followersCount ?? null,
    bio: p.biography ?? null,
    latestPostAt: latestRaw,
    isActive,
  };
}

/**
 * One call to Apify with up to BATCH_SIZE handles. Throws on HTTP error.
 */
async function enrichBatch(
  handles: string[],
  apifyToken: string,
): Promise<EnrichedProfile[]> {
  if (handles.length === 0) return [];

  const url = `${ENDPOINT}?token=${apifyToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: handles }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify ${res.status}: ${text || res.statusText}`);
  }

  const items = (await res.json()) as ApifyProfile[];
  return items.map(mapProfile).filter((p): p is EnrichedProfile => p !== null);
}

/**
 * Enrich a list of handles in batches of `BATCH_SIZE`, sequentially (parallel
 * doesn't help — Apify charges per profile either way, and a single big run
 * makes for a cleaner billing line).
 *
 * Returns a Map<handle (lowercased), profile>. Handles that don't come back
 * (private, deleted, mistyped, blocked by Apify) are simply absent from the
 * map — caller can decide what to do.
 */
export async function enrichAll(
  handles: string[],
  apifyToken: string,
  onBatchStart?: (batchIdx: number, totalBatches: number, batchSize: number) => void,
): Promise<Map<string, EnrichedProfile>> {
  // Dedupe + lowercase up front so we never bill twice for the same profile.
  const unique = Array.from(new Set(handles.map((h) => h.toLowerCase())));
  const out = new Map<string, EnrichedProfile>();
  const totalBatches = Math.ceil(unique.length / BATCH_SIZE);

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    onBatchStart?.(Math.floor(i / BATCH_SIZE) + 1, totalBatches, batch.length);
    const profiles = await enrichBatch(batch, apifyToken);
    for (const p of profiles) out.set(p.handle, p);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Async / polling API for enrichment
// ---------------------------------------------------------------------------
//
// Same trick as discovery: kick off ONE Apify run for hundreds of handles,
// then poll its status from separate Vercel calls. Apify's actor processes
// the whole batch in parallel internally, so 500 handles in one run is way
// faster than 33 separate sync calls — each sync call has a fixed ~5–10 s
// cold-start tax that disappears when amortized across one big run.

const PROFILE_ACTOR_ID = "apify~instagram-profile-scraper";

/**
 * Kick off an Apify enrichment run asynchronously. Returns immediately with
 * the run id — caller polls separately. Handles are deduped + lowercased.
 */
export async function startEnrichmentRun(
  handles: string[],
  apifyToken: string,
): Promise<{ apifyRunId: string }> {
  const unique = Array.from(new Set(handles.map((h) => h.toLowerCase()).filter(Boolean)));
  if (unique.length === 0) throw new Error("startEnrichmentRun: no handles");
  const url = `https://api.apify.com/v2/acts/${PROFILE_ACTOR_ID}/runs?token=${apifyToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: unique }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify enrich start ${res.status}: ${text || res.statusText}`);
  }
  const json = (await res.json()) as { data: { id: string } };
  return { apifyRunId: json.data.id };
}

/**
 * Once an Apify enrichment run reaches SUCCEEDED, fetch its dataset items
 * and map them to our narrowed EnrichedProfile shape.
 */
export async function fetchEnrichmentDataset(
  datasetId: string,
  apifyToken: string,
): Promise<EnrichedProfile[]> {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&limit=10000`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify enrich dataset ${res.status}: ${text || res.statusText}`);
  }
  const items = (await res.json()) as ApifyProfile[];
  return items.map(mapProfile).filter((p): p is EnrichedProfile => p !== null);
}
