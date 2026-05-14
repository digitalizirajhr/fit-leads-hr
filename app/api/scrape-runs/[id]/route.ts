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

  const runRes = await supabase
    .from("scrape_runs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (runRes.error) {
    return NextResponse.json({ error: runRes.error.message }, { status: 500 });
  }
  if (!runRes.data) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  // FK-join through scrape_run_leads → leads. Avoids the IN-list URL-length
  // explosion that the previous .in("id", [...UUIDs]) approach had once a
  // run linked >~400 leads.
  const leadsRes = await supabase
    .from("scrape_run_leads")
    .select("leads(*)")
    .eq("run_id", id)
    .limit(50000);

  if (leadsRes.error) {
    return NextResponse.json({ error: leadsRes.error.message }, { status: 500 });
  }

  // PostgREST's nested-select returns the joined row as either an object
  // or an array depending on inferred cardinality, so we normalize via
  // `unknown` to avoid wrestling with the auto-generated type.
  const rawRows = (leadsRes.data ?? []) as Array<{ leads: unknown }>;
  const leads: Lead[] = [];
  for (const row of rawRows) {
    if (row.leads && typeof row.leads === "object" && !Array.isArray(row.leads)) {
      leads.push(row.leads as Lead);
    } else if (Array.isArray(row.leads)) {
      for (const l of row.leads) leads.push(l as Lead);
    }
  }
  leads.sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const out: ScrapeRunWithLeads = { run: runRes.data as ScrapeRun, leads };
  return NextResponse.json(out);
}
