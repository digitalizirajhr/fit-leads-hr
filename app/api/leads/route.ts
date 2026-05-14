import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import type { Lead, LeadStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/leads?city=&status=&qualified=&noWebsite=&search=
//                &hasPhone=&hasIg=&activeIg=&minRating=&minReviews=&minFollowers=
//
// Defaults match the UX rules from the spec:
//   - qualified: defaults to TRUE (most common case — only show working leads)
//   - noWebsite: defaults to FALSE (no extra filter)
//   - everything else: absent = no filter
//
// Sort is fixed: priority DESC, then most recent first.

function boundedInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const page = boundedInt(sp.get("page"), 1, 1, 10000);
  const pageSize = boundedInt(sp.get("pageSize"), 100, 25, 200);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const city = sp.get("city");
  const status = sp.get("status");
  const search = sp.get("search");
  const qualifiedParam = sp.get("qualified"); // "false" or "true" or null
  const noWebsiteParam = sp.get("noWebsite"); // "true" or null

  const supabase = getServerSupabase();
  let q = supabase.from("leads").select("*", { count: "exact" });

  if (city) q = q.eq("city", city);
  if (status) q = q.eq("status", status as LeadStatus);
  if (qualifiedParam !== "false") q = q.eq("qualified", true);
  if (noWebsiteParam === "true") q = q.eq("has_real_website", false);
  if (search) q = q.ilike("name", `%${search}%`);

  // Per-criterion filters — kept in sync with /leads/page.tsx + the
  // qualification rule in lib/qualification.ts.
  if (sp.get("hasPhone") === "true") {
    q = q.not("phone", "is", null).neq("phone", "");
  }
  if (sp.get("hasIg") === "true") q = q.not("instagram_handle", "is", null);
  if (sp.get("activeIg") === "true") q = q.eq("instagram_is_active", true);

  const minRatingNum = parseFloat(sp.get("minRating") ?? "");
  if (Number.isFinite(minRatingNum)) q = q.gte("google_rating", minRatingNum);

  const minReviewsNum = parseInt(sp.get("minReviews") ?? "", 10);
  if (Number.isFinite(minReviewsNum)) q = q.gte("google_review_count", minReviewsNum);

  const minFollowersNum = parseInt(sp.get("minFollowers") ?? "", 10);
  if (Number.isFinite(minFollowersNum)) q = q.gte("instagram_followers", minFollowersNum);

  q = q
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, to);

  const { data, error, count } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    leads: data as Lead[],
    page,
    pageSize,
    total: count ?? 0,
  });
}
