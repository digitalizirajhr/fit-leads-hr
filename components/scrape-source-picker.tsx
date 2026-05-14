"use client";

import { Button } from "@/components/ui/button";

export type ScrapeSource = "google" | "instagram";

interface Props {
  onPick: (source: ScrapeSource) => void;
}

/**
 * Step 1 of the /scrape multi-step form. Two cards, single-choice.
 * Clicking a card hands control to the corresponding source-specific form.
 */
export function ScrapeSourcePicker({ onPick }: Props) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card
        title="Google Business"
        body="Gyms, fitness studios, and small fitness businesses with phone numbers from Google Maps. Best for established businesses you can cold-call."
        cta="Pick Google"
        onClick={() => onPick("google")}
      />
      <Card
        title="Instagram"
        body="Individual personal trainers via hashtag, location, seed accounts you trust, or bio keyword search. Best for solo coaches without a Google business listing."
        cta="Pick Instagram"
        onClick={() => onPick("instagram")}
      />
    </div>
  );
}

function Card({
  title,
  body,
  cta,
  onClick,
}: {
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-lg border border-border p-6 text-left transition-colors hover:border-foreground/40 hover:bg-muted/30"
    >
      <h3 className="text-base font-medium">{title}</h3>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Button size="sm" variant="outline" className="self-start">
        {cta} →
      </Button>
    </button>
  );
}
