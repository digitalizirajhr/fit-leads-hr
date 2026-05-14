import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import type { Lead, ScrapeRun, ScrapeRunWithLeads } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/scrape-runs/:id → { run, leads } */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const supabase = getServerSupabase();

  const [runRes, linksRes] = await Promise.all([
    supabase.from("scrape_runs").select("*").eq("id", id).maybeSingle(),
    supabase.from("scrape_run_leads").select("lead_id").eq("run_id", id),
  ]);

  if (runRes.error) {
    return NextResponse.json({ error: runRes.error.message }, { status: 500 });
  }
  if (!runRes.data) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (linksRes.error) {
    return NextResponse.json({ error: linksRes.error.message }, { status: 500 });
  }

  const leadIds = (linksRes.data ?? []).map((l) => l.lead_id as string);
  let leads: Lead[] = [];
  if (leadIds.length > 0) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .in("id", leadIds)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    leads = (data ?? []) as Lead[];
  }

  const out: ScrapeRunWithLeads = { run: runRes.data as ScrapeRun, leads };
  return NextResponse.json(out);
}
