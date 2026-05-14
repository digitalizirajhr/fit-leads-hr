import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import type { Lead, LeadStatus, OutreachEntry } from "@/lib/types";

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

// PATCH /api/leads/:id  body: { status?, notes?, priority? }
// Only the three CRM-editable fields are accepted; everything else is silently
// ignored so a stray field on the client can't overwrite scrape-derived data.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

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

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("leads")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  return NextResponse.json(data as Lead);
}
