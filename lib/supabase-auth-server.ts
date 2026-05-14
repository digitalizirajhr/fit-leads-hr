import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server-only Supabase auth client. Imports next/headers, so do NOT import
// this file from any Client Component or shared utility — webpack will
// refuse the build.

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
 * Server-side auth client for Server Components, Route Handlers, and Server
 * Actions. Reads + writes the auth cookie via Next.js cookies() helper.
 */
export async function getServerAuth() {
  const cookieStore = await cookies();
  return createServerClient(projectUrl(), anonKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll throws when invoked from a Server Component (Next.js
          // restriction). The middleware-flow keeps the cookie alive, so this
          // is safe to swallow — just means we couldn't refresh the token
          // from this particular call site.
        }
      },
    },
  });
}
