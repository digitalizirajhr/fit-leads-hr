// Small formatting helpers used across the leads UI.
// Kept dependency-free on purpose — no date-fns / dayjs needed for what we do.

/**
 * Returns "3 days ago", "just now", "in 2 hours", or "—" if input is null.
 * Uses Intl.RelativeTimeFormat with the Croatian locale so the unit names are
 * localized (e.g. "prije 3 dana"). Falls back gracefully for very old dates.
 */
export function formatRelativeTime(date: string | null | undefined): string {
  if (!date) return "—";
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return "—";

  const diffSec = Math.round((then - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];

  let value = diffSec;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let abs = absSec;
  for (const [u, divisor] of units) {
    unit = u;
    if (abs < divisor) break;
    value = Math.round(value / divisor);
    abs = Math.abs(value);
  }

  return new Intl.RelativeTimeFormat("hr", { numeric: "auto" }).format(value, unit);
}

/**
 * Croatian-locale string compare. Use as the sort comparator anywhere we sort
 * strings the user will read (lead names, cities). Keeps Č after C, Ć after Č,
 * etc., which JS's default sort gets wrong.
 */
export function croatianSort(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? "").localeCompare(b ?? "", "hr");
}

/**
 * Display-friendly URL: strips protocol + trailing slash, truncates with an
 * ellipsis if longer than `max`. Returns the original input if already short.
 */
export function truncateUrl(url: string, max = 32): string {
  const cleaned = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1) + "…";
}
