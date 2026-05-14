import { NextRequest, NextResponse } from "next/server";
import { finalizeScrapeRun } from "@/lib/scrape-runs";
import { requireAuth } from "@/lib/require-auth";
import { rejectCrossSiteMutation } from "@/lib/request-guards";
import type { ScrapeCounts, ScrapeRunStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const VALID_STATUSES: ScrapeRunStatus[] = ["done", "error"];

/** POST /api/scrape-runs/:id/finalize → set ended_at + status + counts. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  const blocked = rejectCrossSiteMutation(req);
  if (blocked) return blocked;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (!VALID_STATUSES.includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  const counts: ScrapeCounts =
    body.counts && typeof body.counts === "object" ? body.counts : {};
  const errorMessage =
    typeof body.error_message === "string" ? body.error_message : null;

  try {
    await finalizeScrapeRun(
      id,
      body.status as ScrapeRunStatus,
      counts,
      errorMessage,
    );
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
