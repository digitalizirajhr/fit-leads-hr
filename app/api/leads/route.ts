import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import type { Lead, LeadStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/leads?city=&status=&qualified=&noWebsite=&search=
//
// Defaults match the UX rules from the spec:
//   - qualified: defaults to TRUE (most common case — only show working leads)
//   - noWebsite: defaults to FALSE (no extra filter)
//   - everything else: absent = no filter
//
// Sort is fixed: priority DESC, then most recent first.

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const city = sp.get("city");
  const status = sp.get("status");
  const search = sp.get("search");
  const qualifiedParam = sp.get("qualified"); // "false" or "true" or null
  const noWebsiteParam = sp.get("noWebsite"); // "true" or null

  const supabase = getServerSupabase();
  let q = supabase.from("leads").select("*");

  if (city) q = q.eq("city", city);
  if (status) q = q.eq("status", status as LeadStatus);
  if (qualifiedParam !== "false") q = q.eq("qualified", true);
  if (noWebsiteParam === "true") q = q.eq("has_real_website", false);
  if (search) q = q.ilike("name", `%${search}%`);

  q = q.order("priority", { ascending: false }).order("created_at", { ascending: false });

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data as Lead[]);
}
