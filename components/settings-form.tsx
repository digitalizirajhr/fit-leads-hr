"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { QualificationRule } from "@/lib/types";

interface Props {
  initialRule: QualificationRule;
  initialQualifiedCount: number;
  cities: string[]; // distinct cities present in DB (for the city restriction picker)
}

/**
 * Qualification rule editor. Each criterion is a Toggle (boolean) or
 * ThresholdToggle (boolean + numeric threshold) or CityRestriction.
 *
 * Auto-saves on every change via PATCH /api/settings. Recompute is
 * a separate explicit button below.
 */
export function SettingsForm({ initialRule, initialQualifiedCount, cities }: Props) {
  const router = useRouter();
  const [rule, setRule] = useState<QualificationRule>(initialRule);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [, startTransition] = useTransition();

  function commit(next: QualificationRule) {
    setRule(next); // optimistic
    startTransition(async () => {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: next }),
      });
      if (res.ok) {
        setSavedAt(Date.now());
        router.refresh();
      }
    });
  }

  async function recompute() {
    setRecomputing(true);
    setRecomputeMsg("Recomputing…");
    const res = await fetch("/api/settings/recompute-qualified", { method: "POST" });
    setRecomputing(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setRecomputeMsg(`Failed: ${body.error ?? res.status}`);
      return;
    }
    const out = (await res.json()) as { updated: number; qualified: number; unqualified: number };
    setRecomputeMsg(`Done. ${out.qualified} qualified · ${out.unqualified} not · ${out.updated} reviewed.`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Toggle
        label="Require: no real website"
        hint="Lead's listed website is null, social-only, or unreachable."
        checked={rule.requireNoWebsite}
        onChange={(v) => commit({ ...rule, requireNoWebsite: v })}
      />
      <Toggle
        label="Require: has a phone number"
        hint="Without this you can't actually call them."
        checked={rule.requirePhone}
        onChange={(v) => commit({ ...rule, requirePhone: v })}
      />

      <ThresholdToggle
        label="Min Google rating"
        hint="Filter out leads with poor or missing Google reviews."
        value={rule.minGoogleRating}
        placeholder="e.g. 4.0"
        step="0.1"
        onChange={(v) => commit({ ...rule, minGoogleRating: v })}
      />
      <ThresholdToggle
        label="Min Google review count"
        hint="Drop leads that nobody has reviewed."
        value={rule.minReviewCount}
        placeholder="e.g. 5"
        step="1"
        onChange={(v) => commit({ ...rule, minReviewCount: v })}
      />

      <Toggle
        label="Require: has Instagram handle"
        hint="At least an IG handle present (set by enrichment or a website that points to an IG profile)."
        checked={rule.requireInstagram}
        onChange={(v) => commit({ ...rule, requireInstagram: v })}
      />
      <Toggle
        label="Require: active on Instagram (last 30 days)"
        hint="Posted something recently — proxy for 'still in business'."
        checked={rule.requireActiveInstagram}
        onChange={(v) => commit({ ...rule, requireActiveInstagram: v })}
      />
      <ThresholdToggle
        label="Min Instagram followers"
        hint="Skip dormant or fake-looking accounts."
        value={rule.minInstagramFollowers}
        placeholder="e.g. 500"
        step="1"
        onChange={(v) => commit({ ...rule, minInstagramFollowers: v })}
      />

      <CityRestriction
        cities={cities}
        value={rule.allowedCities}
        onChange={(v) => commit({ ...rule, allowedCities: v })}
      />

      <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4">
        <Button onClick={recompute} disabled={recomputing}>
          {recomputing
            ? "Recomputing…"
            : `Recompute qualified for ${initialQualifiedCount} lead${initialQualifiedCount === 1 ? "" : "s"}`}
        </Button>
        {recomputeMsg ? (
          <span className="text-xs text-muted-foreground">{recomputeMsg}</span>
        ) : savedAt ? (
          <span className="text-xs text-muted-foreground">
            Auto-saved {Math.max(0, Math.floor((Date.now() - savedAt) / 1000))}s ago
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function ThresholdToggle({
  label,
  hint,
  value,
  placeholder,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  placeholder: string;
  step: string;
  onChange: (v: number | null) => void;
}) {
  const enabled = value !== null;
  // Local draft so we don't fire commit on every keystroke; commit on blur instead.
  const [draft, setDraft] = useState(value?.toString() ?? "");

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-2">
        {enabled ? (
          <Input
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const n = Number(draft);
              if (Number.isFinite(n) && n >= 0) onChange(n);
            }}
            placeholder={placeholder}
            step={step}
            className="h-8 w-24"
          />
        ) : null}
        <Switch
          checked={enabled}
          onCheckedChange={(v) => {
            if (v) {
              const n = Number(draft);
              onChange(Number.isFinite(n) && n >= 0 ? n : 0);
            } else {
              onChange(null);
            }
          }}
        />
      </div>
    </div>
  );
}

function CityRestriction({
  cities,
  value,
  onChange,
}: {
  cities: string[];
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const enabled = value !== null;
  const selected = new Set(value ?? []);

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <Label className="text-sm">Restrict to specific cities</Label>
        <p className="text-xs text-muted-foreground">
          Tick the cities you want to focus on. Untick the switch to disable the restriction entirely.
        </p>
        {enabled ? (
          cities.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No cities in your leads yet — run a scrape first.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {cities.map((c) => {
                const on = selected.has(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      const next = new Set(selected);
                      if (on) next.delete(c);
                      else next.add(c);
                      onChange(Array.from(next));
                    }}
                    className={
                      "rounded-md border px-2 py-1 text-xs transition-colors " +
                      (on
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground hover:text-foreground")
                    }
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          )
        ) : null}
      </div>
      <Switch checked={enabled} onCheckedChange={(v) => onChange(v ? [] : null)} />
    </div>
  );
}
