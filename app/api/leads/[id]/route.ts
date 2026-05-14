import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { computeQualified, type LeadForRule } from "@/lib/qualification";
import {
  DEFAULT_RULE,
  type Lead,
  type LeadStatus,
  type OutreachEntry,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STATUSES: LeadStatus[] = [
  "new", "contacted", "replied", "booked", "closed", "dead",
];

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/leads/:id  →  { lead, outreach }
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = getServerSupabase();

  const [leadRes, outreachRes] = await Promise.all([
    supabase.from("leads").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("outreach_log")
      .select("*")
      .eq("lead_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (leadRes.error) return NextResponse.json({ error: leadRes.error.message }, { status: 500 });
  if (!leadRes.data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (outreachRes.error) {
    return NextResponse.json({ error: outreachRes.error.message }, { status: 500 });
  }

  return NextResponse.json({
    lead: leadRes.data as Lead,
    outreach: (outreachRes.data ?? []) as OutreachEntry[],
  });
}

// PATCH /api/leads/:id  body: { status?, notes?, priority?, qualified_override? }
//
// Only these CRM-editable fields are accepted; everything else is silently
// ignored so a stray field on the client can't overwrite scrape-derived data.
//
// qualified_override has 3-state semantics:
//   null  → clear override; recompute `qualified` from current rule
//   true  → force qualified = true
//   false → force qualified = false
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  // Plain CRM fields
  const patch: Partial<Pick<Lead, "status" | "notes" | "priority">> = {};

  if (typeof body.status === "string") {
    if (!ALLOWED_STATUSES.includes(body.status as LeadStatus)) {
      return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
    }
    patch.status = body.status as LeadStatus;
  }
  if (typeof body.notes === "string" || body.notes === null) {
    patch.notes = body.notes;
  }
  if (typeof body.priority === "number") {
    if (body.priority < 0 || body.priority > 5 || !Number.isInteger(body.priority)) {
      return NextResponse.json({ error: "priority must be an integer 0..5" }, { status: 400 });
    }
    patch.priority = body.priority;
  }

  // qualified_override is its own special handling — needs to also update `qualified`.
  let overrideToSet: boolean | null | undefined = undefined;
  if (
    body.qualified_override === null ||
    body.qualified_override === true ||
    body.qualified_override === false
  ) {
    overrideToSet = body.qualified_override;
  }

  if (Object.keys(patch).length === 0 && overrideToSet === undefined) {
    return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
  }

  const supabase = getServerSupabase();

  // 1. Apply plain CRM patch (status / notes / priority) if any
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 2. Apply qualified_override if supplied
  if (overrideToSet !== undefined) {
    if (overrideToSet === null) {
      // Clearing the override → recompute `qualified` against DEFAULT_RULE.
      // There's no longer a persisted global rule (it lives per-scrape now);
      // DEFAULT_RULE is a sensible fallback so the lead lands in a defined
      // state instead of keeping stale data from whenever it was last scraped.
      const { data: row, error: rowErr } = await supabase
        .from("leads")
        .select(
          "has_real_website, phone, google_rating, google_review_count, instagram_handle, instagram_is_active, instagram_followers, city",
        )
        .eq("id", id)
        .maybeSingle();
      if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 });
      if (!row) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

      const recomputedQualified = computeQualified(
        row as unknown as LeadForRule,
        DEFAULT_RULE,
      );

      const { error } = await supabase
        .from("leads")
        .update({ qualified_override: null, qualified: recomputedQualified })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      // Forcing true/false → set both columns to match.
      const { error } = await supabase
        .from("leads")
        .update({ qualified_override: overrideToSet, qualified: overrideToSet })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 3. Read back the latest row
  const { data: latest, error: readErr } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!latest) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  return NextResponse.json(latest as Lead);
}
