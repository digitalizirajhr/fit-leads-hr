// Two-stage classifier: cheap keyword check + (optional) Claude Haiku
// fallback for misses. Returns the subset of EnrichedProfile that should be
// kept as fitness coaches.

import type { EnrichedProfile } from "@/lib/instagram";

// Croatian + English fitness/sports terms. Lowercase substring match.
const COACH_KEYWORDS = [
  "trener", "trenerica", "trening",
  "coach", "fitness", "kineziolog", "kineziologija",
  "personalni trener", "personal trainer",
  "bodybuilder", "bodybuilding",
  "sportaš", "sportašica", "sport",
  "powerlifting", "weightlifting",
  "yoga", "joga", "pilates", "crossfit",
  "nutricionist", "nutritionist",
];

function passesKeywordFilter(bio: string | null): boolean {
  if (!bio) return false;
  const lower = bio.toLowerCase();
  return COACH_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * AI fallback: ask Claude Haiku if the bio describes a fitness pro.
 * Returns true on YES, false on NO or any error (fail-closed — don't keep
 * unverified profiles when the API errors).
 */
async function aiClassifyBio(bio: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 5,
        messages: [
          {
            role: "user",
            content: `Instagram bio: "${bio}"\n\nIs this person a fitness or sports professional in Croatia (trainer, coach, kinesiologist, athlete, gym owner)? Reply only YES or NO.`,
          },
        ],
      }),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = json.content?.[0]?.text?.trim().toUpperCase() ?? "";
    return text.startsWith("YES");
  } catch {
    return false;
  }
}

/**
 * Filter profiles to those plausibly being fitness coaches.
 *   - Pass 1: bio keyword match → keep
 *   - Pass 2 (only if ANTHROPIC_API_KEY set): AI fallback for keyword misses
 *
 * Returns kept profiles in input order.
 */
export async function filterCoaches(
  profiles: EnrichedProfile[],
  opts?: { onAiCall?: (count: number) => void },
): Promise<EnrichedProfile[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const kept: EnrichedProfile[] = [];
  const aiCandidates: EnrichedProfile[] = [];

  for (const p of profiles) {
    if (passesKeywordFilter(p.bio)) {
      kept.push(p);
    } else if (apiKey && p.bio && p.bio.trim().length > 0) {
      aiCandidates.push(p);
    }
  }

  if (apiKey && aiCandidates.length > 0) {
    opts?.onAiCall?.(aiCandidates.length);
    // Sequential to keep cost / rate-limit predictable. Haiku is fast.
    for (const p of aiCandidates) {
      const isCoach = await aiClassifyBio(p.bio!, apiKey);
      if (isCoach) kept.push(p);
    }
  }

  return kept;
}
