// "Does this lead actually have a website?" logic.
//
// has_real_website rules (from spec section 7):
//   - false if the URL is null/empty
//   - false if the URL contains a known social-only host
//   - false if a HEAD request times out (5s) or returns non-2xx
//   - true otherwise
//
// Concurrency: limit HEAD requests to 10 in flight so a 200-lead scrape
// doesn't fan out 200 simultaneous sockets (slow for us, rude to the host).

const SOCIAL_HOST_FRAGMENTS = [
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "linkin.bio",
  "linktree",
  "bento.me",
];

const HEAD_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 10;

export function isSocialOnly(url: string): boolean {
  const lower = url.toLowerCase();
  return SOCIAL_HOST_FRAGMENTS.some((frag) => lower.includes(frag));
}

/**
 * Returns true if the URL points to what looks like a "real" website.
 * Never throws — failures and timeouts collapse to `false`.
 */
export async function checkWebsite(url: string | null | undefined): Promise<boolean> {
  if (!url || url.trim().length === 0) return false;
  if (isSocialOnly(url)) return false;

  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      redirect: "follow",
    });
    return res.ok;
  } catch {
    // Some servers reject HEAD with 405 or hang. Try a small GET as fallback —
    // we set Range: bytes=0-0 so we don't actually download the body.
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
      });
      return res.ok || res.status === 206;
    } catch {
      return false;
    }
  }
}

/**
 * Run an async fn over a list with bounded concurrency. Returns results in
 * input order. Used here for HEAD requests, but written as a generic so it can
 * be reused (e.g. Apify batching in step 8 if we ever need parallel).
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Check many URLs in parallel (capped at `concurrency`). Returns a results
 * array aligned to the input array.
 */
export function checkWebsitesParallel(
  urls: Array<string | null | undefined>,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<boolean[]> {
  return mapConcurrent(urls, concurrency, (u) => checkWebsite(u));
}
