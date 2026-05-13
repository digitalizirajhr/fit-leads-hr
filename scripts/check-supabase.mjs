// One-off connection check. Run with:
//   node --env-file=.env.local scripts/check-supabase.mjs
//
// Confirms:
//  1. NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY are set
//  2. The `leads` and `outreach_log` tables exist
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

console.log(`[ok]   url present: ${url.replace(/^(https:\/\/)([^.]+).*/, "$1$2***")}`);
console.log(`[ok]   service key present (length ${serviceKey.length})`);

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

for (const table of ["leads", "outreach_log"]) {
  const { error, count } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) {
    console.error(`[fail] ${table}: ${error.message}`);
    process.exit(1);
  }
  console.log(`[ok]   ${table}: exists, ${count ?? 0} rows`);
}

console.log("\nAll good. Supabase is reachable and the schema is in place.");
