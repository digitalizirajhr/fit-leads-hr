import { getServerSupabase } from "@/lib/supabase-server";
import { DEFAULT_RULE, type QualificationRule } from "@/lib/types";
import { SettingsForm } from "@/components/settings-form";
import { CustomTermsManager } from "@/components/custom-terms-manager";

export const dynamic = "force-dynamic";

/**
 * /settings — qualification rule editor + custom search terms manager.
 *
 * Server-renders the current settings + distinct cities (for the city
 * restriction picker) + count of rule-eligible leads (for the recompute
 * button label). The two interactive bits live in their own client
 * components.
 */
export default async function SettingsPage() {
  const supabase = getServerSupabase();

  const [settingsRes, citiesRes, countRes] = await Promise.all([
    supabase
      .from("settings")
      .select("qualification_rules, custom_terms")
      .eq("id", "singleton")
      .maybeSingle(),
    supabase.from("leads").select("city").not("city", "is", null),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .is("qualified_override", null),
  ]);

  const rule: QualificationRule = {
    ...DEFAULT_RULE,
    ...((settingsRes.data?.qualification_rules as Partial<QualificationRule>) ?? {}),
  };
  const customTerms = (settingsRes.data?.custom_terms as string[]) ?? [];
  const cities = Array.from(
    new Set(((citiesRes.data ?? []) as { city: string }[]).map((r) => r.city)),
  ).sort((a, b) => a.localeCompare(b, "hr"));
  const ruleEligibleCount = countRes.count ?? 0;

  return (
    <main className="mx-auto max-w-screen-md space-y-8 p-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tune the qualification rule and manage your custom search terms. Changes
          auto-save. Recompute applies the rule to existing leads (skipping any with
          a manual override).
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Qualification rule</h2>
        <SettingsForm
          initialRule={rule}
          initialQualifiedCount={ruleEligibleCount}
          cities={cities}
        />
      </section>

      <section className="space-y-3 border-t border-border pt-6">
        <h2 className="text-sm font-medium text-muted-foreground">Custom search terms</h2>
        <p className="text-xs text-muted-foreground">
          Added here, these appear as additional checkboxes alongside the 6 defaults
          on <code>/scrape</code>.
        </p>
        <CustomTermsManager initialTerms={customTerms} />
      </section>
    </main>
  );
}
