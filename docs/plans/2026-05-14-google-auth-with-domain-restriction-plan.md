# Google Auth with Domain Restriction — Implementation Plan

> **For Claude (next session):** REQUIRED SUB-SKILL: superpowers:executing-plans. No automated tests in this project — verify each task with the curl/browser command given. Pause for Igor's confirmation at any "Verify with Igor" step.

**Goal:** Replace non-working Vercel Authentication with Supabase Auth + Google OAuth, restricted to `@digitaliziraj.hr` emails. Protect all pages and API routes.

**Architecture:** `@supabase/ssr` cookie-based sessions. Middleware gates every request except `/login`, `/auth/*`, and Next.js statics. OAuth callback handler does the domain check; rejects with `auth.admin.deleteUser()` cleanup on bad domain.

**Tech Stack:** Same as v1 — Next.js 14 App Router · TypeScript · Supabase JS · `@supabase/ssr` (new).

**Design doc:** `docs/plans/2026-05-14-google-auth-with-domain-restriction-design.md`.

---

## Pre-flight: Igor's setup steps (parallel to my coding)

### Task 0a: Google OAuth client in Google Cloud Console

Tell Igor:

1. Go to **https://console.cloud.google.com/** (the project where your Places API key lives — top-bar dropdown should say `fit-leads-hr` or similar)
2. Hamburger → **APIs & Services → Credentials**
3. Top → **+ Create Credentials → OAuth client ID**
4. If prompted to **Configure OAuth consent screen** first:
   - User Type: **External**
   - App name: `fit-leads-hr`
   - User support email: your `@digitaliziraj.hr` email
   - Developer contact: same
   - Scopes: leave default (Google adds email/profile automatically)
   - Test users: add your `@digitaliziraj.hr` email so you can sign in while in "Testing" status
   - Save & continue through all steps
5. Back at Credentials → **+ Create Credentials → OAuth client ID**
6. Application type: **Web application**
7. Name: `fit-leads-hr supabase auth`
8. **Authorized redirect URIs** → click Add URI → paste exactly: `https://snrexkypwfiyvufpiatk.supabase.co/auth/v1/callback`
9. Click **Create**
10. Copy the **Client ID** AND **Client Secret** (modal will show both — keep them around for Task 0b)

### Task 0b: Enable Google provider in Supabase

Tell Igor:

1. Supabase → **Authentication** (left sidebar) → **Providers**
2. Find **Google** → toggle on
3. Paste **Client IDs** (paste the Google Client ID) and **Client Secret (for OAuth)** (paste the Google Client Secret)
4. Save
5. Authentication → **URL Configuration** → scroll to **Redirect URLs**
6. Add both:
   - `http://localhost:3000/auth/callback`
   - `https://fit-leads-hr.vercel.app/auth/callback`
7. Save

Reply: "auth setup done" before moving past Phase 4 (the smoke test needs Google to actually work).

---

## Phase 1 — Install + lib

### Task 1: Install `@supabase/ssr`

**Files:** `package.json`, `package-lock.json`

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
npm install @supabase/ssr
```

Expected: `added N packages` line.

**No commit yet** — bundle with Task 2.

### Task 2: `lib/supabase-auth.ts`

**Files:**
- Create: `lib/supabase-auth.ts`

**Step 1: Write file**

```ts
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Same URL normalization trick as lib/supabase-server.ts so an accidental
// trailing /rest/v1 in NEXT_PUBLIC_SUPABASE_URL doesn't crash auth.
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
```

**Step 2: Verify**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npx tsc --noEmit
```
Expected: zero errors.

**Step 3: Commit Phase 1**

```bash
git add package.json package-lock.json lib/supabase-auth.ts
git commit -m "feat(auth): install @supabase/ssr + browser/server clients"
```

---

## Phase 2 — Login + auth routes

### Task 3: `app/login/page.tsx`

**Files:**
- Create: `app/login/page.tsx`

**Step 1: Write file**

```tsx
"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getBrowserAuth } from "@/lib/supabase-auth";

const ALLOWED_DOMAIN_HUMAN = "@digitaliziraj.hr";

export default function LoginPage() {
  const sp = useSearchParams();
  const errorParam = sp.get("error");
  const [busy, setBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setOauthError(null);
    const supabase = getBrowserAuth();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        // Hint to Google that we want a hosted-domain account. Google still
        // shows the picker, but pre-filters to the right org if the user has
        // multiple accounts. The actual enforcement happens in our callback.
        queryParams: { hd: "digitaliziraj.hr" },
      },
    });
    if (error) {
      setOauthError(error.message);
      setBusy(false);
    }
    // Successful start of OAuth → browser navigates to Google; nothing more here.
  }

  const errorMessage =
    errorParam === "wrong-domain"
      ? `Only ${ALLOWED_DOMAIN_HUMAN} accounts are allowed. Try again with the right account.`
      : errorParam === "no-code"
        ? "OAuth callback didn't include a code. Try again."
        : errorParam === "exchange"
          ? "Couldn't complete sign-in. Try again."
          : oauthError;

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center gap-6 p-6 text-center">
      <h1 className="text-2xl font-semibold">fit-leads-hr</h1>
      <p className="text-sm text-muted-foreground">
        Personal lead-gen CRM for Croatian fitness coaches. Sign in to continue.
      </p>

      <Button onClick={signIn} disabled={busy} size="lg">
        {busy ? "Redirecting…" : "Sign in with Google"}
      </Button>

      <p className="text-xs text-muted-foreground">
        Only {ALLOWED_DOMAIN_HUMAN} accounts can sign in.
      </p>

      {errorMessage ? (
        <p className="text-sm text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </main>
  );
}
```

**Step 2: Verify**

Skip — won't render correctly until middleware (Task 6) and callback (Task 4) exist. Commit with Phase 2.

---

### Task 4: `app/auth/callback/route.ts`

**Files:**
- Create: `app/auth/callback/route.ts`

**Step 1: Write file**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerAuth } from "@/lib/supabase-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DOMAIN = "@digitaliziraj.hr";

/**
 * GET /auth/callback?code=…
 *
 * Google OAuth redirects here after the user picks an account. We exchange
 * the code for a Supabase session, then enforce the domain restriction:
 *   - If email ends with @digitaliziraj.hr → land on /leads
 *   - Else → delete the just-created user via admin API, sign out, redirect
 *     back to /login with an error banner.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=no-code", req.url));
  }

  const supabase = await getServerAuth();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data?.user) {
    return NextResponse.redirect(new URL("/login?error=exchange", req.url));
  }

  const email = data.user.email ?? "";
  if (!email.toLowerCase().endsWith(ALLOWED_DOMAIN)) {
    // Reject: clean up the just-created auth user so they don't accumulate.
    // Uses the service-role admin client (separate from the cookie-bound
    // session client) to call the admin API.
    const projectUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
    const admin = createClient(projectUrl, process.env.SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    try {
      await admin.auth.admin.deleteUser(data.user.id);
    } catch {
      // Best-effort cleanup; don't block the sign-out path on this.
    }

    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=wrong-domain", req.url));
  }

  return NextResponse.redirect(new URL("/leads", req.url));
}
```

**Step 2: Verify**

Skip — needs Igor's Google + Supabase setup to test. Commit with Phase 2.

---

### Task 5: `app/auth/signout/route.ts`

**Files:**
- Create: `app/auth/signout/route.ts`

**Step 1: Write file**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { getServerAuth } from "@/lib/supabase-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /auth/signout
 *
 * Clears the Supabase session cookie and redirects to /login. POST (not GET)
 * so a stray prefetch / link visit can't accidentally sign the user out.
 * Triggered by the small <form> in the layout's nav.
 */
export async function POST(req: NextRequest) {
  const supabase = await getServerAuth();
  await supabase.auth.signOut();
  // 303 See Other → browser switches POST to GET for the redirect target.
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
```

**Step 2: Commit Phase 2**

```bash
git add app/login/page.tsx app/auth/callback/route.ts app/auth/signout/route.ts
git commit -m "feat(auth): /login page + /auth/callback (with domain check) + /auth/signout"
```

---

## Phase 3 — Middleware gate

### Task 6: `middleware.ts`

**Files:**
- Create: `middleware.ts`

**Step 1: Write file**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const ALLOWED_DOMAIN = "@digitaliziraj.hr";

/**
 * Auth gate. Every request goes through here unless excluded by `config.matcher`.
 *
 * Rules:
 *   - /login, /auth/*, _next/*, /favicon.ico → public, pass through
 *   - Everything else → require a valid Supabase session whose user.email
 *     ends with @digitaliziraj.hr
 *   - API routes (/api/*) get 401 JSON; pages get redirected to /login
 *
 * The domain re-check here is defense in depth — the auth/callback route
 * already enforces it, but if a session somehow exists for the wrong domain
 * (e.g. someone manually crafted a cookie), middleware also blocks.
 */
export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Public allowlist
  if (
    path === "/login" ||
    path.startsWith("/auth/") ||
    path === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Build a response we can write cookies to (Supabase will refresh tokens).
  let response = NextResponse.next({ request: req });
  const projectUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1$/, "");

  const supabase = createServerClient(
    projectUrl,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const emailOk = user?.email?.toLowerCase().endsWith(ALLOWED_DOMAIN);

  if (!user || !emailOk) {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: user ? "Forbidden (wrong domain)" : "Unauthorized" },
        { status: user ? 403 : 401 },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    if (user && !emailOk) url.searchParams.set("error", "wrong-domain");
    return NextResponse.redirect(url);
  }

  return response;
}

// Skip the middleware for Next.js internals + static files. Everything else
// (pages + API) goes through the gate.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

**Step 2: Verify**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npx tsc --noEmit
```
Expected: zero errors.

```bash
curl -s -o /dev/null -w "logged-out /leads: %{http_code}\n" http://localhost:3000/leads
curl -s -o /dev/null -w "logged-out /api/leads: %{http_code}\n" http://localhost:3000/api/leads
curl -s -o /dev/null -w "/login: %{http_code}\n" http://localhost:3000/login
```
Expected:
- `logged-out /leads: 307` (redirect to /login)
- `logged-out /api/leads: 401`
- `/login: 200`

**Step 3: Commit**

```bash
git add middleware.ts
git commit -m "feat(auth): middleware gate (everything except /login + /auth/*)"
```

---

## Phase 4 — Layout: user info + sign-out button

### Task 7: Update `app/layout.tsx`

**Files:**
- Modify: `app/layout.tsx`

**Step 1: Patch**

Add to imports:
```tsx
import { getServerAuth } from "@/lib/supabase-auth";
```

Convert the `RootLayout` function to async (so we can fetch the user):
```tsx
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await getServerAuth();
  const { data: { user } } = await supabase.auth.getUser();
```

Replace the existing nav block:
```tsx
        <nav className="flex items-center gap-4 border-b border-border px-6 py-2 text-sm">
          <Link href="/leads" className="font-medium hover:text-foreground/80">
            Leads
          </Link>
          <Link href="/scrape" className="text-muted-foreground hover:text-foreground">
            Scrape
          </Link>
          <span className="ml-auto text-xs text-muted-foreground">fit-leads-hr</span>
        </nav>
```
with:
```tsx
        <nav className="flex items-center gap-4 border-b border-border px-6 py-2 text-sm">
          <Link href="/leads" className="font-medium hover:text-foreground/80">
            Leads
          </Link>
          <Link href="/scrape" className="text-muted-foreground hover:text-foreground">
            Scrape
          </Link>
          {user ? (
            <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              <span>{user.email}</span>
              <form action="/auth/signout" method="POST">
                <button
                  type="submit"
                  className="underline-offset-4 hover:text-foreground hover:underline"
                >
                  Sign out
                </button>
              </form>
            </span>
          ) : (
            <span className="ml-auto text-xs text-muted-foreground">fit-leads-hr</span>
          )}
        </nav>
```

**Step 2: Verify**

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npm run build 2>&1 | tail -10
```
Expected: build succeeds, no type errors.

**Step 3: Commit**

```bash
git add app/layout.tsx
git commit -m "feat(auth): show user email + Sign out in nav when authenticated"
```

---

## Phase 5 — Verify + ship

### Task 8: Local end-to-end smoke test (with Igor)

**Pre-condition:** Igor has completed Tasks 0a + 0b ("auth setup done").

1. Restart the dev server so it picks up the middleware:
   ```bash
   pkill -f "next dev"; sleep 1
   cd /Users/chartfumonkey/Code/fit-leads-hr && rm -rf .next && npm run dev &
   ```
2. Igor opens `http://localhost:3000/leads` in browser
3. Should redirect to `/login`. Page shows "Sign in with Google" button.
4. Click button → Google account picker
5. Pick `igor@digitaliziraj.hr` (or whatever his digitaliziraj account is)
6. Land on `/leads` with email + Sign out in top-right nav
7. Click around, then Sign out — back to `/login`
8. Try a wrong domain (e.g. personal Gmail) — should land on `/login?error=wrong-domain` with red error banner
9. Curl `/api/leads` without a session cookie — `401`

If step 4 fails ("redirect_uri_mismatch"): Google's authorized redirect URI doesn't match. Re-check Task 0a step 8.

If step 5 fails ("invalid_request" or similar): Supabase's redirect URLs list doesn't include our callback. Re-check Task 0b step 6.

### Task 9: Commit + push (gh switch dance)

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
gh auth switch -u digitalizirajhr
git push
gh auth switch -u ChartFuMonkey
```

Vercel auto-rebuilds. Watch for build success.

### Task 10: Igor verifies on production

Once Vercel build completes:
1. Visit `https://fit-leads-hr.vercel.app/leads` in incognito → redirects to `/login`
2. Sign in with `@digitaliziraj.hr` Google account → /leads loads
3. Curl `https://fit-leads-hr.vercel.app/api/leads` from Terminal → `401` (was `200` before)

### Task 11: Igor disables Vercel Authentication

Once Task 10 succeeds:

1. Vercel dashboard → fit-leads-hr → **Settings → Deployment Protection**
2. Toggle **Vercel Authentication → Require Log In** OFF
3. Save
4. Reload `https://fit-leads-hr.vercel.app/leads` in incognito → still hits OUR /login (not Vercel's auth wall) — confirming our auth is the gate now

---

## Build verification checklist

Before each push, run:
```bash
cd /Users/chartfumonkey/Code/fit-leads-hr && npm run build
```
Build must complete with no type errors.

## Rollback notes

If something goes badly wrong with the auth flow on production and you need a quick rollback:

```bash
cd /Users/chartfumonkey/Code/fit-leads-hr
git revert HEAD~5..HEAD   # adjust range to cover the auth commits
git push
```

Then re-enable Vercel Authentication in the dashboard until you can debug.

The Supabase project's Google provider can also be toggled OFF without code changes — the /login page would then show an OAuth error when clicking the button, but the rest of the app stays accessible (modulo middleware blocking everything).
