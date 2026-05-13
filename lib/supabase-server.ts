import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client. Uses the service-role / secret key, which
// BYPASSES Row Level Security. Never import this file from a Client Component
// or anything that runs in the browser — Next.js will refuse to bundle a file
// that imports `process.env.SUPABASE_SERVICE_KEY` into a client bundle, but
// keeping it in its own module is an extra safety net.
//
// We export a function (not a singleton) so the client is created fresh per
// request. That avoids accidentally sharing connection state between requests.

export function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in environment.",
    );
  }

  return createClient(url, serviceKey, {
    auth: {
      // We don't want the server client to try to manage user sessions —
      // there is no user, and persisted state would leak between requests.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
