import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { DEFAULT_RULE, type QualificationRule, type Settings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/settings → current Settings
export async function GET() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("settings")
    .select("qualification_rules, custom_terms")
    .eq("id", "singleton")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Settings row missing" }, { status: 500 });

  // Merge with DEFAULT_RULE so if we add fields to QualificationRule later,
  // existing DB rows that don't have those fields still validate.
  const rule: QualificationRule = {
    ...DEFAULT_RULE,
    ...((data.qualification_rules as Partial<QualificationRule>) ?? {}),
  };
  const settings: Settings = {
    rule,
    customTerms: (data.custom_terms as string[]) ?? [],
  };
  return NextResponse.json(settings);
}

// PATCH /api/settings → partial update of rule and/or customTerms
// Returns the full new Settings (calls GET).
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  const supabase = getServerSupabase();

  if (body.rule && typeof body.rule === "object") {
    // Read existing then merge so the client only has to send the fields
    // they're changing.
    const { data: existingRow } = await supabase
      .from("settings")
      .select("qualification_rules")
      .eq("id", "singleton")
      .maybeSingle();
    const existing = (existingRow?.qualification_rules as Partial<QualificationRule>) ?? {};
    updates.qualification_rules = {
      ...DEFAULT_RULE,
      ...existing,
      ...(body.rule as Partial<QualificationRule>),
    };
  }

  if (Array.isArray(body.customTerms)) {
    // Trim, drop empties, dedupe (case-sensitive — "yoga" vs "Yoga" stay distinct).
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const t of body.customTerms as unknown[]) {
      if (typeof t !== "string") continue;
      const trimmed = t.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    updates.custom_terms = cleaned;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "no recognised fields to update (expected 'rule' and/or 'customTerms')" },
      { status: 400 },
    );
  }

  const { error } = await supabase.from("settings").update(updates).eq("id", "singleton");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Return the full new state — saves the client a round-trip.
  return GET();
}
