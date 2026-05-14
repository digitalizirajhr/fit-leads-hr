import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { computeQualified, type LeadForRule } from "@/lib/qualification";
import { DEFAULT_RULE, type QualificationRule } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/settings/recompute-qualified
 *
 * Re-runs qualification across every lead where qualified_override IS NULL,
 * using the current rule from settings. Two batched UPDATEs (one per
 * outcome) so we don't issue N round-trips.
 *
 * Returns { updated, qualified, unqualified } counts.
 */
export async function POST() {
  const supabase = getServerSupabase();

  // 1. Read the current rule
  const { data: settingsRow, error: settingsErr } = await supabase
    .from("settings")
    .select("qualification_rules")
    .eq("id", "singleton")
    .maybeSingle();
  if (settingsErr) {
    return NextResponse.json({ error: `settings: ${settingsErr.message}` }, { status: 500 });
  }
  const rule: QualificationRule = {
    ...DEFAULT_RULE,
    ...((settingsRow?.qualification_rules as Partial<QualificationRule>) ?? {}),
  };

  // 2. Pull all rule-eligible leads (only the columns the rule reads)
  const { data: leads, error: leadsErr } = await supabase
    .from("leads")
    .select(
      "id, has_real_website, phone, google_rating, google_review_count, instagram_handle, instagram_is_active, instagram_followers, city",
    )
    .is("qualified_override", null);
  if (leadsErr) {
    return NextResponse.json({ error: `leads: ${leadsErr.message}` }, { status: 500 });
  }

  // 3. Bucket each lead's id into one of two arrays
  const trueIds: string[] = [];
  const falseIds: string[] = [];
  for (const lead of leads ?? []) {
    const isQualified = computeQualified(lead as unknown as LeadForRule, rule);
    (isQualified ? trueIds : falseIds).push(lead.id as string);
  }

  // 4. One UPDATE per outcome (avoids N round-trips). Skipped if empty.
  if (trueIds.length > 0) {
    const { error } = await supabase.from("leads").update({ qualified: true }).in("id", trueIds);
    if (error) {
      return NextResponse.json({ error: `update qualified=true: ${error.message}` }, { status: 500 });
    }
  }
  if (falseIds.length > 0) {
    const { error } = await supabase.from("leads").update({ qualified: false }).in("id", falseIds);
    if (error) {
      return NextResponse.json({ error: `update qualified=false: ${error.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({
    updated: trueIds.length + falseIds.length,
    qualified: trueIds.length,
    unqualified: falseIds.length,
  });
}
