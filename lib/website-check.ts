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

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "linkin.bio",
  "bento.me",
];

const HEAD_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 10;

export function isSocialOnly(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return SOCIAL_HOSTS.some((socialHost) => {
    return host === socialHost || host.endsWith(`.${socialHost}`);
  });
}

function parseHttpUrl(raw: string | null | undefined): URL | null {
  if (!raw || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:") ||
    lower.startsWith("::ffff:10.") ||
    lower.startsWith("::ffff:127.") ||
    lower.startsWith("::ffff:192.168.")
  );
}

async function isSafeExternalUrl(url: URL): Promise<boolean> {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;

  const directIp = isIP(host);
  if (directIp === 4) return !isPrivateIpv4(host);
  if (directIp === 6) return !isPrivateIpv6(host);

  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.every((address) => {
      if (address.family === 4) return !isPrivateIpv4(address.address);
      if (address.family === 6) return !isPrivateIpv6(address.address);
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL points to what looks like a "real" website.
 * Never throws — failures and timeouts collapse to `false`.
 */
export async function checkWebsite(url: string | null | undefined): Promise<boolean> {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  if (isSocialOnly(parsed.toString())) return false;
  if (!(await isSafeExternalUrl(parsed))) return false;

  try {
    const res = await fetch(parsed, {
      method: "HEAD",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      redirect: "follow",
    });
    return res.ok;
  } catch {
    // Some servers reject HEAD with 405 or hang. Try a small GET as fallback —
    // we set Range: bytes=0-0 so we don't actually download the body.
    try {
      const res = await fetch(parsed, {
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
