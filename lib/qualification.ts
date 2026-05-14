import { DEFAULT_RULE, type Lead, type QualificationRule } from "@/lib/types";

/**
 * Subset of Lead fields the rule reads. Used by the recompute endpoint to
 * keep its SELECT narrow (less data over the wire), and to type the row we
 * synthesize for the in-scrape `qualified` calculation (where IG fields
 * aren't enriched yet).
 */
export type LeadForRule = Pick<
  Lead,
  | "has_real_website"
  | "phone"
  | "google_rating"
  | "google_review_count"
  | "instagram_handle"
  | "instagram_is_active"
  | "instagram_followers"
  | "city"
>;

function finiteNumberOrNull(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

function nonNegativeIntegerOrNull(
  value: unknown,
  fallback: number | null,
): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.trunc(value);
  return int >= 0 ? int : fallback;
}

/**
 * Normalize untrusted JSON into a complete qualification rule. Request bodies
 * and stored run params are user-controlled data, so callers should never
 * spread them directly over DEFAULT_RULE.
 */
export function normalizeQualificationRule(
  input: unknown,
  fallback: QualificationRule = DEFAULT_RULE,
): QualificationRule {
  const src =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const minGoogleRating = finiteNumberOrNull(
    src.minGoogleRating,
    fallback.minGoogleRating,
  );

  return {
    requireNoWebsite:
      typeof src.requireNoWebsite === "boolean"
        ? src.requireNoWebsite
        : fallback.requireNoWebsite,
    requirePhone:
      typeof src.requirePhone === "boolean" ? src.requirePhone : fallback.requirePhone,
    minGoogleRating:
      minGoogleRating === null ? null : Math.min(5, Math.max(0, minGoogleRating)),
    minReviewCount: nonNegativeIntegerOrNull(
      src.minReviewCount,
      fallback.minReviewCount,
    ),
    requireInstagram:
      typeof src.requireInstagram === "boolean"
        ? src.requireInstagram
        : fallback.requireInstagram,
    requireActiveInstagram:
      typeof src.requireActiveInstagram === "boolean"
        ? src.requireActiveInstagram
        : fallback.requireActiveInstagram,
    minInstagramFollowers: nonNegativeIntegerOrNull(
      src.minInstagramFollowers,
      fallback.minInstagramFollowers,
    ),
    allowedCities: Array.isArray(src.allowedCities)
      ? src.allowedCities
          .filter((city): city is string => typeof city === "string")
          .map((city) => city.trim())
          .filter(Boolean)
      : src.allowedCities === null
        ? null
        : fallback.allowedCities,
  };
}

export function qualificationRuleFromParams(params: unknown): QualificationRule {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return DEFAULT_RULE;
  }
  return normalizeQualificationRule((params as Record<string, unknown>).rule);
}

/**
 * Pure function — given a lead's fields and a rule, returns whether the lead
 * is qualified per the rule. Same logic shared by /api/scrape (new rows) and
 * /api/settings/recompute-qualified (existing rows).
 *
 * AND across all enabled criteria. Disabled criteria pass through.
 * Missing values for numerical thresholds (null `google_rating` etc) are
 * treated as failing the threshold — null is "we don't know" which is
 * conservative for outreach.
 */
export function computeQualified(lead: LeadForRule, rule: QualificationRule): boolean {
  if (rule.requireNoWebsite && lead.has_real_website) return false;
  if (rule.requirePhone && !(lead.phone && lead.phone.trim().length > 0)) return false;
  if (rule.minGoogleRating !== null && (lead.google_rating ?? -1) < rule.minGoogleRating) return false;
  if (rule.minReviewCount !== null && (lead.google_review_count ?? -1) < rule.minReviewCount) return false;
  if (rule.requireInstagram && !lead.instagram_handle) return false;
  if (rule.requireActiveInstagram && lead.instagram_is_active !== true) return false;
  if (rule.minInstagramFollowers !== null && (lead.instagram_followers ?? -1) < rule.minInstagramFollowers) return false;
  if (rule.allowedCities !== null && rule.allowedCities.length > 0) {
    if (!lead.city || !rule.allowedCities.includes(lead.city)) return false;
  }
  return true;
}
