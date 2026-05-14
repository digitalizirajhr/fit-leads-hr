// Shared types matching the Supabase schema in the project README / spec.
// Anything that crosses an API boundary should be typed via these.

export type LeadStatus =
  | "new"
  | "contacted"
  | "replied"
  | "booked"
  | "closed"
  | "dead";

export type OutreachMethod =
  | "instagram_dm"
  | "email"
  | "phone"
  | "whatsapp"
  | "other";

export interface Lead {
  id: string;
  created_at: string;
  updated_at: string;

  // From Google Places
  place_id: string;
  name: string;
  phone: string | null;
  current_website: string | null;
  address: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  google_rating: number | null;
  google_review_count: number | null;

  // From Instagram enrichment
  instagram_handle: string | null;
  instagram_followers: number | null;
  instagram_bio: string | null;
  instagram_last_post_at: string | null;
  instagram_is_active: boolean | null;

  // Derived flags
  has_real_website: boolean;
  qualified: boolean;
  /** Manual override of `qualified`. null = follow rule, true/false = forced. */
  qualified_override: boolean | null;

  // CRM fields
  status: LeadStatus;
  priority: number;
  notes: string | null;

  // Outreach summary
  contacted_at: string | null;
  last_contact_method: OutreachMethod | null;
}

export interface OutreachEntry {
  id: string;
  lead_id: string;
  created_at: string;
  method: OutreachMethod;
  message: string | null;
  response: string | null;
}

// Server-Sent Event payload streamed by /api/scrape.
// `stage` is the discriminator — UI uses it to color/group log lines.
export type ScrapeStage =
  | "searching"
  | "filtering"
  | "enriching"
  | "saving"
  | "done"
  | "error";

/**
 * Configurable qualification rule, edited via /settings and stored in the
 * singleton `settings` row's `qualification_rules` JSONB column. AND logic
 * across all enabled criteria — disabled criteria pass through.
 */
export interface QualificationRule {
  requireNoWebsite: boolean;
  requirePhone: boolean;
  minGoogleRating: number | null;
  minReviewCount: number | null;
  requireInstagram: boolean;
  requireActiveInstagram: boolean;
  minInstagramFollowers: number | null;
  /** null = no city restriction. Empty array also means "no restriction" (the
   *  toggle is on but no cities ticked yet). */
  allowedCities: string[] | null;
}

export const DEFAULT_RULE: QualificationRule = {
  requireNoWebsite: true,
  requirePhone: true,
  minGoogleRating: null,
  minReviewCount: null,
  requireInstagram: false,
  requireActiveInstagram: false,
  minInstagramFollowers: null,
  allowedCities: null,
};

/** What /api/settings returns. */
export interface Settings {
  rule: QualificationRule;
  customTerms: string[];
}

export interface ScrapeEvent {
  stage: ScrapeStage;
  city?: string;
  term?: string;
  message: string;
  counts?: {
    found?: number;
    qualified?: number;
    new?: number;
    skipped?: number;
    /** IG enrich: how many leads we updated this batch. */
    processed?: number;
    /** IG enrich: how many candidates remain after this batch (client polls until 0). */
    remaining?: number;
  };
}
