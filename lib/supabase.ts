import { createClient } from "@supabase/supabase-js";

// Browser-safe Supabase client. Uses the publishable / anon key, which is safe
// to ship to the client because Row Level Security (when enabled) controls reads.
// In v1 we don't actually use this from the browser much — most reads/writes go
// through our /api routes which use the server client below — but it's wired up
// so we have the option later.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in environment.",
  );
}

export const supabase = createClient(url, anonKey);
