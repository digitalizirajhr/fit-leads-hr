import { createClient } from "@supabase/supabase-js";

// Browser-safe Supabase client. Uses the publishable / anon key, which is safe
// to ship to the client because Row Level Security (when enabled) controls reads.
// In v1 we don't actually use this from the browser much — most reads/writes go
// through our /api routes which use the server client below — but it's wired up
// so we have the option later.

const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!rawUrl || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in environment.",
  );
}

// Normalize: a common copy-paste mistake is to grab the full REST URL from
// Supabase ("https://xxx.supabase.co/rest/v1/") instead of just the project URL.
// Strip the trailing /rest/v1 (with optional slash) and any extra slashes.
const url = rawUrl.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");

export const supabase = createClient(url, anonKey);
