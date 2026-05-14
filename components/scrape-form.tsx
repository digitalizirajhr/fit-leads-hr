"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CustomTermsManager } from "@/components/custom-terms-manager";
import { QualificationRuleForm } from "@/components/qualification-rule-form";
import type { QualificationRule } from "@/lib/types";

const CITIES = [
  "Zagreb", "Split", "Rijeka", "Osijek", "Zadar",
  "Pula", "Slavonski Brod", "Karlovac", "Varaždin",
  "Šibenik", "Dubrovnik", "Velika Gorica", "Sisak",
  "Vinkovci", "Bjelovar", "Koprivnica", "Čakovec",
];

const TERMS = [
  "personal trainer",
  "fitness trener",
  "fitness coach",
  "teretana",
  "fitness studio",
  "kineziolog",
];

export interface ScrapeRequest {
  cities: string[];
  terms: string[];
  enrichInstagram: boolean;
  skipExisting: boolean;
  /** Per-scrape qualification rule. Sent in each chunk's POST body so /api/scrape
   *  doesn't need to consult any global state. */
  rule: QualificationRule;
}

interface Props {
  onSubmit: (req: ScrapeRequest) => void;
  running: boolean;
  customTerms: string[];
  /** Owned by the parent so reload doesn't accidentally lose form state via
   *  this component re-mount; here it just renders + reports changes back. */
  rule: QualificationRule;
  onRuleChange: (next: QualificationRule) => void;
  /** Distinct cities currently in the DB — drives the city-restriction picker
   *  inside the qualification rule form. */
  citiesInDb: string[];
  /** Step 1 (source picker) navigation back hook. */
  onBack: () => void;
}

export function ScrapeForm({
  onSubmit,
  running,
  customTerms,
  rule,
  onRuleChange,
  citiesInDb,
  onBack,
}: Props) {
  const [selectedCities, setSelectedCities] = useState<Set<string>>(new Set());
  const [selectedTerms, setSelectedTerms] = useState<Set<string>>(new Set());
  const [enrichInstagram, setEnrichInstagram] = useState(false);
  const [skipExisting, setSkipExisting] = useState(true);

  // Defaults + Igor's custom terms (managed inline in the term section below).
  const ALL_TERMS = [...TERMS, ...customTerms];

  function toggleSet<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  const canRun =
    selectedCities.size > 0 && selectedTerms.size > 0 && !running;

  function submit() {
    onSubmit({
      cities: Array.from(selectedCities),
      terms: Array.from(selectedTerms),
      enrichInstagram,
      skipExisting,
      rule,
    });
  }

  return (
    <div className="space-y-6 rounded-lg border border-border p-6">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Back to source picker
      </button>

      {/* Cities */}
      <Section
        title="Cities"
        actions={
          <>
            <BulkLink onClick={() => setSelectedCities(new Set(CITIES))}>Select all</BulkLink>
            <span className="text-muted-foreground">·</span>
            <BulkLink onClick={() => setSelectedCities(new Set())}>Clear</BulkLink>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 md:grid-cols-4">
          {CITIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedCities.has(c)}
                onCheckedChange={() => setSelectedCities((s) => toggleSet(s, c))}
              />
              {c}
            </label>
          ))}
        </div>
      </Section>

      {/* Terms */}
      <Section
        title="Search terms"
        actions={
          <>
            <BulkLink onClick={() => setSelectedTerms(new Set(ALL_TERMS))}>Select all</BulkLink>
            <span className="text-muted-foreground">·</span>
            <BulkLink onClick={() => setSelectedTerms(new Set())}>Clear</BulkLink>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {ALL_TERMS.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedTerms.has(t)}
                onCheckedChange={() => setSelectedTerms((s) => toggleSet(s, t))}
              />
              {t}
            </label>
          ))}
        </div>

        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 text-xs text-muted-foreground">
            Add a custom term — saved persistently, appears here next time too.
          </p>
          <CustomTermsManager initialTerms={customTerms} />
        </div>
      </Section>

      {/* Qualification rule — applied per-scrape, does not persist */}
      <Section
        title="Qualification criteria"
        actions={
          <span className="text-xs text-muted-foreground">resets on reload</span>
        }
      >
        <QualificationRuleForm rule={rule} onChange={onRuleChange} cities={citiesInDb} />
      </Section>

      {/* Toggles */}
      <div className="space-y-3">
        <label className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm">Skip leads I already have</Label>
            <p className="text-xs text-muted-foreground">
              Dedupe by place_id against the existing DB. Saves API calls on re-runs.
            </p>
          </div>
          <Switch checked={skipExisting} onCheckedChange={setSkipExisting} />
        </label>

        <label className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm">Also enrich with Instagram (Apify)</Label>
            <p className="text-xs text-muted-foreground">
              For leads whose listed website is an Instagram URL: pull follower count,
              bio, and last-post timestamp. ~€0.002 per profile. Skips leads already enriched.
            </p>
          </div>
          <Switch checked={enrichInstagram} onCheckedChange={setEnrichInstagram} />
        </label>
      </div>

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-muted-foreground">
          {selectedCities.size} cities × {selectedTerms.size} terms ={" "}
          <span className="text-foreground">
            {selectedCities.size * selectedTerms.size}
          </span>{" "}
          base queries (cap of 3 pages each, ≈ ${(
            selectedCities.size * selectedTerms.size * 3 * 0.035
          ).toFixed(2)} max)
        </p>
        <Button onClick={submit} disabled={!canRun} size="lg">
          {running ? "Running…" : "Run scrape"}
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="flex items-center gap-2 text-xs">{actions}</div>
      </div>
      {children}
    </div>
  );
}

function BulkLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      {children}
    </button>
  );
}
