// One-off connection check. Run with:
//   node --env-file=.env.local scripts/check-supabase.mjs
//
// Confirms:
//  1. NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY are set
//  2. The expected application tables exist
//  3. We can read from them with the service-role key
//
// Safe to delete after first successful run.

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!url) {
  console.error("[fail] NEXT_PUBLIC_SUPABASE_URL is not set");
  process.exit(1);
}
if (!serviceKey) {
  console.error("[fail] SUPABASE_SERVICE_KEY is not set");
  process.exit(1);
}

const projectUrl = url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");

console.log(`[ok]   url present: ${projectUrl.replace(/^(https:\/\/)([^.]+).*/, "$1$2***")}`);
console.log(`[ok]   service key present (length ${serviceKey.length})`);

const supabase = createClient(projectUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

for (const table of [
  "leads",
  "outreach_log",
  "settings",
  "scrape_runs",
  "scrape_run_leads",
]) {
  const { error, count } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) {
    console.error(`[fail] ${table}: ${error.message}`);
    process.exit(1);
  }
  console.log(`[ok]   ${table}: exists, ${count ?? 0} rows`);
}

const { error: leadColumnError } = await supabase
  .from("leads")
  .select("id, qualified_override, instagram_followers, instagram_handle", {
    count: "exact",
    head: true,
  });
if (leadColumnError) {
  console.error(`[fail] leads expected columns: ${leadColumnError.message}`);
  process.exit(1);
}
console.log("[ok]   leads expected audit columns exist");

console.log("\nAll good. Supabase is reachable and the schema is in place.");
