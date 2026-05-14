"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { QualificationRule } from "@/lib/types";

interface Props {
  rule: QualificationRule;
  onChange: (next: QualificationRule) => void;
  /** Cities to surface in the city-restriction picker. */
  cities: string[];
}

/**
 * The 8 qualification-criteria controls. Parent-controlled — no internal
 * state, no autosave, no API calls. The owner (e.g. the scrape form) decides
 * what to do with the changes (typically: stash in component state and send
 * along with the next scrape request).
 */
export function QualificationRuleForm({ rule, onChange, cities }: Props) {
  return (
    <div className="space-y-4">
      <Toggle
        label="Require: no real website"
        hint="Lead's listed website is null, social-only, or unreachable."
        checked={rule.requireNoWebsite}
        onChange={(v) => onChange({ ...rule, requireNoWebsite: v })}
      />
      <Toggle
        label="Require: has a phone number"
        hint="Without this you can't actually call them."
        checked={rule.requirePhone}
        onChange={(v) => onChange({ ...rule, requirePhone: v })}
      />
      <ThresholdToggle
        label="Min Google rating"
        hint="Filter out leads with poor or missing Google reviews."
        value={rule.minGoogleRating}
        placeholder="e.g. 4.0"
        step="0.1"
        onChange={(v) => onChange({ ...rule, minGoogleRating: v })}
      />
      <ThresholdToggle
        label="Min Google review count"
        hint="Drop leads that nobody has reviewed."
        value={rule.minReviewCount}
        placeholder="e.g. 5"
        step="1"
        onChange={(v) => onChange({ ...rule, minReviewCount: v })}
      />
      <Toggle
        label="Require: has Instagram handle"
        hint="At least an IG handle present (set by enrichment or a website that points to an IG profile)."
        checked={rule.requireInstagram}
        onChange={(v) => onChange({ ...rule, requireInstagram: v })}
      />
      <Toggle
        label="Require: active on Instagram (last 30 days)"
        hint="Posted something recently — proxy for 'still in business'."
        checked={rule.requireActiveInstagram}
        onChange={(v) => onChange({ ...rule, requireActiveInstagram: v })}
      />
      <ThresholdToggle
        label="Min Instagram followers"
        hint="Skip dormant or fake-looking accounts."
        value={rule.minInstagramFollowers}
        placeholder="e.g. 500"
        step="1"
        onChange={(v) => onChange({ ...rule, minInstagramFollowers: v })}
      />
      <CityRestriction
        cities={cities}
        value={rule.allowedCities}
        onChange={(v) => onChange({ ...rule, allowedCities: v })}
      />
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
  // Local draft so we don't fire onChange on every keystroke; commit on blur.
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
        <Label className="text-sm">Restrict qualified to specific cities</Label>
        <p className="text-xs text-muted-foreground">
          Tick the cities you want qualified leads in. Untick the switch to disable the restriction.
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
