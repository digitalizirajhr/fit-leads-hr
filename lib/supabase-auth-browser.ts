import { createBrowserClient } from "@supabase/ssr";

// Browser-safe Supabase auth client — no next/headers imports.
// Same URL normalization as the other clients to tolerate a trailing /rest/v1.

function projectUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return raw.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
}

function anonKey(): string {
  const k = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!k) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  return k;
}

/**
 * Browser-side auth client. Use in Client Components for sign-in actions.
 * Cookies are managed automatically by @supabase/ssr.
 */
export function getBrowserAuth() {
  return createBrowserClient(projectUrl(), anonKey());
}
