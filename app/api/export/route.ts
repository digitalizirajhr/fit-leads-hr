import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { toCsv, toJson, exportFilename } from "@/lib/export";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/export
 * Body: { leadIds: string[], format: "csv" | "json" }
 *
 * Returns the file as a download. Looks up the latest data by id (so the
 * export reflects whatever's currently in the DB, not whatever the client
 * had cached when the user ticked the checkboxes).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ids: unknown = body.leadIds;
  const format: unknown = body.format;

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string")) {
    return NextResponse.json(
      { error: "leadIds must be a non-empty array of strings" },
      { status: 400 },
    );
  }
  if (format !== "csv" && format !== "json") {
    return NextResponse.json({ error: "format must be 'csv' or 'json'" }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .in("id", ids as string[]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const leads = (data ?? []) as Lead[];
  const filename = exportFilename(format);

  const body_str = format === "csv" ? toCsv(leads) : toJson(leads);
  const contentType = format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";

  return new Response(body_str, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
