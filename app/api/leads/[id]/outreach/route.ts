import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import type { OutreachEntry, OutreachMethod } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_METHODS: OutreachMethod[] = [
  "instagram_dm", "email", "phone", "whatsapp", "other",
];

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/leads/:id/outreach
 *
 * Body: { method, message, response? }
 *
 * Three side effects, in order:
 *   1. Insert into outreach_log
 *   2. Update the parent lead row: contacted_at = now(), last_contact_method = method
 *   3. If the lead's current status is "new", bump it to "contacted"
 *
 * We use a follow-up SELECT to read the current status so we know whether
 * to bump it. No transaction (Supabase JS doesn't expose them) — for a
 * one-user tool this race is fine.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (!ALLOWED_METHODS.includes(body.method)) {
    return NextResponse.json({ error: `Invalid method: ${body.method}` }, { status: 400 });
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const supabase = getServerSupabase();

  // 1. Insert the log entry
  const { data: entryData, error: insertErr } = await supabase
    .from("outreach_log")
    .insert({
      lead_id: id,
      method: body.method,
      message: body.message,
      response: typeof body.response === "string" ? body.response : null,
    })
    .select()
    .maybeSingle();

  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  // 2. Read current status so we can decide whether to bump it
  const { data: leadRow, error: readErr } = await supabase
    .from("leads")
    .select("status")
    .eq("id", id)
    .maybeSingle();

  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!leadRow) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  // 3. Patch the lead — always update contacted_at + method; bump status only if "new"
  const update: Record<string, unknown> = {
    contacted_at: new Date().toISOString(),
    last_contact_method: body.method,
  };
  if (leadRow.status === "new") update.status = "contacted";

  const { error: updateErr } = await supabase.from("leads").update(update).eq("id", id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json(entryData as OutreachEntry);
}
