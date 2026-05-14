import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { readStringArray, rejectCrossSiteMutation } from "@/lib/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/settings — manages custom search terms only.
 *
 * The qualification rule used to live here too, but it moved onto /scrape
 * as a per-request body field (see docs/plans/2026-05-14-rule-on-scrape-design.md).
 * The settings table still has a `qualification_rules` column from the prior
 * design — we leave it untouched (no migration); it's just dead data now.
 */

interface SettingsResponse {
  customTerms: string[];
}

// GET → { customTerms }
export async function GET() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("settings")
    .select("custom_terms")
    .eq("id", "singleton")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Settings row missing" }, { status: 500 });

  const out: SettingsResponse = { customTerms: (data.custom_terms as string[]) ?? [] };
  return NextResponse.json(out);
}

// PATCH → update custom_terms (any other body fields silently ignored).
export async function PATCH(req: NextRequest) {
  const blocked = rejectCrossSiteMutation(req);
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));

  const parsedTerms = readStringArray(body.customTerms, {
    field: "customTerms",
    maxItems: 200,
    maxLength: 80,
  });
  if (!parsedTerms.ok) return parsedTerms.response;

  // Trim, drop empties, dedupe (case-sensitive — "yoga" vs "Yoga" stay distinct).
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const trimmed of parsedTerms.value) {
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }

  const supabase = getServerSupabase();
  const { error } = await supabase
    .from("settings")
    .update({ custom_terms: cleaned })
    .eq("id", "singleton");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Return the latest state — saves a round-trip.
  return GET();
}
