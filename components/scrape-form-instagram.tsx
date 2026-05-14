"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { QualificationRuleForm } from "@/components/qualification-rule-form";
import type { DiscoveryMethod } from "@/lib/instagram-discovery";
import type { QualificationRule } from "@/lib/types";

export interface InstagramScrapeRequest {
  methods: Array<{ method: DiscoveryMethod; values: string[] }>;
  skipExisting: boolean;
  rule: QualificationRule;
}

interface Props {
  onSubmit: (req: InstagramScrapeRequest) => void;
  onBack: () => void;
  running: boolean;
  rule: QualificationRule;
  onRuleChange: (next: QualificationRule) => void;
  citiesInDb: string[];
}

/**
 * Step 2b of /scrape — Instagram discovery form. Four optional input fields,
 * one per discovery method; empty fields are skipped on submit.
 */
export function ScrapeFormInstagram({
  onSubmit,
  onBack,
  running,
  rule,
  onRuleChange,
  citiesInDb,
}: Props) {
  const [hashtags, setHashtags] = useState("");
  const [locations, setLocations] = useState("");
  const [seeds, setSeeds] = useState("");
  const [bioKeywords, setBioKeywords] = useState("");
  const [skipExisting, setSkipExisting] = useState(true);

  function parseList(s: string): string[] {
    return s
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const methods = [
    { method: "hashtag" as const, values: parseList(hashtags) },
    { method: "location" as const, values: parseList(locations) },
    { method: "seed" as const, values: parseList(seeds) },
    { method: "bio_keyword" as const, values: parseList(bioKeywords) },
  ].filter((m) => m.values.length > 0);

  const totalQueries = methods.reduce((n, m) => n + m.values.length, 0);
  const canRun = methods.length > 0 && !running;

  return (
    <div className="space-y-6 rounded-lg border border-border p-6">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Back to source picker
      </button>

      <div>
        <h2 className="text-base font-medium">Instagram discovery</h2>
        <p className="text-xs text-muted-foreground">
          Fill in any combination — empty fields are skipped.
        </p>
      </div>

      <Field
        label="Hashtags"
        hint='Comma-separated, no #. e.g. "personalnitrenerzagreb, fitnesstrenerhrvatska"'
        value={hashtags}
        onChange={setHashtags}
      />
      <Field
        label="Locations"
        hint='Comma-separated location names. e.g. "Zagreb, Split, Crossfit Zagreb"'
        value={locations}
        onChange={setLocations}
      />
      <Field
        label="Seed accounts"
        hint='Comma-separated usernames, no @. e.g. "iyaprivanovic, vilim.puclin". Pulls their followers.'
        value={seeds}
        onChange={setSeeds}
      />
      <Field
        label="Bio keyword search"
        hint='Comma-separated keywords. e.g. "kineziolog zagreb, fitness trener split"'
        value={bioKeywords}
        onChange={setBioKeywords}
      />

      <div className="border-t border-border pt-4">
        <label className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm">Skip leads I already have</Label>
            <p className="text-xs text-muted-foreground">
              Dedupe by IG handle / synthetic ig:HANDLE place_id against the existing DB.
            </p>
          </div>
          <Switch checked={skipExisting} onCheckedChange={setSkipExisting} />
        </label>
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Qualification criteria</h3>
          <span className="text-xs text-muted-foreground">resets on reload</span>
        </div>
        <QualificationRuleForm rule={rule} onChange={onRuleChange} cities={citiesInDb} />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">
          {methods.length === 0
            ? "Fill in at least one discovery field"
            : `${methods.length} method${methods.length === 1 ? "" : "s"} ready · ` +
              `${totalQueries} value${totalQueries === 1 ? "" : "s"}`}
        </p>
        <Button
          onClick={() => onSubmit({ methods, skipExisting, rule })}
          disabled={!canRun}
          size="lg"
        >
          {running ? "Running…" : "Run scrape"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-sm">{label}</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 max-w-2xl"
      />
    </div>
  );
}
