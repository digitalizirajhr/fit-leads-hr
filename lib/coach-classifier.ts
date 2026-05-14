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
 * Returns true on YES from the model, false on a clear NO, and `null`
 * on any API/network error so the caller can decide what to do.
 */
async function aiClassifyBio(bio: string, apiKey: string): Promise<boolean | null> {
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
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = json.content?.[0]?.text?.trim().toUpperCase() ?? "";
    if (text.startsWith("YES")) return true;
    if (text.startsWith("NO")) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Filter profiles to those plausibly being fitness coaches.
 *
 * Behavior:
 *   - Profile bio matches a fitness keyword → kept (high confidence)
 *   - No keyword match + AI key present + AI says YES → kept
 *   - No keyword match + AI key present + AI says NO → DROPPED
 *   - No keyword match + AI key NOT present → kept (fail-open — better to
 *     show possibly-non-coach profiles than silently lose real coaches)
 *   - No keyword match + AI key present but errors (no credits, network) →
 *     kept (same fail-open principle)
 *
 * Net: when AI is broken, you get more leads + need to manually qualify.
 * When AI works, the AI does the triage and you get clean results.
 */
export async function filterCoaches(
  profiles: EnrichedProfile[],
  opts?: { onAiCall?: (count: number) => void; onAiError?: (count: number) => void },
): Promise<EnrichedProfile[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const kept: EnrichedProfile[] = [];
  const aiCandidates: EnrichedProfile[] = [];

  for (const p of profiles) {
    if (passesKeywordFilter(p.bio)) {
      kept.push(p);
    } else if (apiKey && p.bio && p.bio.trim().length > 0) {
      // Defer to AI; tracked separately below.
      aiCandidates.push(p);
    } else {
      // No AI available at all → keep, let user triage manually.
      kept.push(p);
    }
  }

  if (apiKey && aiCandidates.length > 0) {
    opts?.onAiCall?.(aiCandidates.length);
    // Parallel — each Haiku call is ~500-1500 ms; sequential adds up
    // fast at 15-25 candidates per batch. Anthropic's free tier and our
    // first paid tier both allow plenty of concurrent requests for
    // single-user workloads, so concurrency isn't a real risk.
    const verdicts = await Promise.all(
      aiCandidates.map((p) => aiClassifyBio(p.bio!, apiKey)),
    );
    let errorCount = 0;
    for (let i = 0; i < aiCandidates.length; i++) {
      const p = aiCandidates[i];
      const verdict = verdicts[i];
      if (verdict === true) {
        kept.push(p);
      } else if (verdict === null) {
        // AI errored (no credits, network, etc.) — fail-open: keep.
        kept.push(p);
        errorCount++;
      }
      // verdict === false → confidently dropped
    }
    if (errorCount > 0) opts?.onAiError?.(errorCount);
  }

  return kept;
}
