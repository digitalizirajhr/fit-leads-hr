import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase-server";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatusSelect } from "@/components/status-select";
import { PriorityStars } from "@/components/priority-stars";
import { NotesEditor } from "@/components/notes-editor";
import { OutreachLog } from "@/components/outreach-log";
import { AddOutreachForm } from "@/components/add-outreach-form";
import { CopyText } from "@/components/copy-text";
import { QualifiedToggle } from "@/components/qualified-toggle";
import { formatRelativeTime, truncateUrl } from "@/lib/format";
import type { Lead, OutreachEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LeadDetailPage({ params }: PageProps) {
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

  if (leadRes.error) {
    return (
      <main className="mx-auto max-w-screen-xl p-6">
        <p className="text-destructive">Error loading lead: {leadRes.error.message}</p>
      </main>
    );
  }
  if (!leadRes.data) notFound();

  const lead = leadRes.data as Lead;
  const outreach = (outreachRes.data ?? []) as OutreachEntry[];

  return (
    <main className="mx-auto max-w-screen-xl space-y-6 p-6">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-border pb-4">
        <Link
          href="/leads"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          ← All leads
        </Link>
        <h1 className="text-xl font-semibold">{lead.name}</h1>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <QualifiedToggle
            leadId={lead.id}
            qualified={lead.qualified}
            qualifiedOverride={lead.qualified_override}
          />
          {lead.qualified_override === true
            ? "qualified (manual)"
            : lead.qualified_override === false
              ? "unqualified (manual)"
              : lead.qualified
                ? "qualified (rule)"
                : "not qualified (rule)"}
        </span>
        <div className="ml-auto">
          <StatusSelect leadId={lead.id} value={lead.status} />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_1fr]">
        {/* LEFT: facts */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Facts</h2>

          <Field label="Phone">
            {lead.phone ? (
              <CopyText value={lead.phone} />
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Field>

          <Field label="Address">
            {lead.address ? lead.address : <span className="text-muted-foreground">—</span>}
            {lead.city ? <span className="text-muted-foreground"> · {lead.city}</span> : null}
          </Field>

          <Field label="Google rating">
            {lead.google_rating != null ? (
              <span>
                ★ {lead.google_rating.toFixed(1)}{" "}
                <span className="text-muted-foreground">
                  ({lead.google_review_count ?? 0} reviews)
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Field>

          <Field label="Current website">
            {lead.current_website ? (
              <a
                href={lead.current_website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm hover:underline underline-offset-4"
              >
                {truncateUrl(lead.current_website, 60)}
              </a>
            ) : (
              <Badge variant="destructive" className="font-normal">
                ❌ none
              </Badge>
            )}
          </Field>

          <Separator />

          <h3 className="text-sm font-medium text-muted-foreground">Instagram</h3>
          <Field label="Handle">
            {lead.instagram_handle ? `@${lead.instagram_handle}` : <span className="text-muted-foreground">—</span>}
          </Field>
          <Field label="Followers">
            {lead.instagram_followers != null ? (
              <span>
                {Intl.NumberFormat("hr").format(lead.instagram_followers)}{" "}
                {lead.instagram_is_active ? (
                  <Badge variant="secondary" className="ml-2 bg-green-900/40 text-green-300">
                    active
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="ml-2">
                    inactive
                  </Badge>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Field>
          <Field label="Bio">
            {lead.instagram_bio ? (
              <span className="whitespace-pre-wrap">{lead.instagram_bio}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Field>
          <Field label="Last post">
            {lead.instagram_last_post_at ? (
              <span>{formatRelativeTime(lead.instagram_last_post_at)}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Field>

          <Separator />

          <div className="space-y-1 text-xs text-muted-foreground">
            <div>place_id: {lead.place_id}</div>
            <div>created: {new Date(lead.created_at).toLocaleString("hr")}</div>
            <div>updated: {new Date(lead.updated_at).toLocaleString("hr")}</div>
          </div>
        </section>

        {/* RIGHT: CRM */}
        <section className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Priority</h2>
            <PriorityStars leadId={lead.id} value={lead.priority} />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Notes</h2>
            <NotesEditor leadId={lead.id} initial={lead.notes} />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Outreach log</h2>
            <OutreachLog entries={outreach} />
          </div>

          <AddOutreachForm leadId={lead.id} />
        </section>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-baseline gap-3 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
