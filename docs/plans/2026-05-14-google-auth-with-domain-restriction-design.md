# Google Auth with Domain Restriction — Design

**Date:** 2026-05-14
**Status:** approved (Igor: "yes")

## Goal

Replace Vercel Authentication (which we just discovered isn't actually blocking traffic on the production URL) with our own app-level Google OAuth login. Restrict to email addresses ending in `@digitaliziraj.hr` only.

Two motivations:
1. **Security** — `/api/leads` is currently public; anyone can curl `https://fit-leads-hr.vercel.app/api/leads` and get the full lead pipeline (names, phones).
2. **Control** — domain restriction keeps the app to the digitaliziraj.hr team only.

## Approach

**Supabase Auth + Google provider + post-callback domain check.** Supabase Auth is built into the Supabase project we already use; no extra service / dependency / cost. Sessions live in HTTP-only cookies via `@supabase/ssr`.

## Auth flow

```
User → /leads
  middleware: no session cookie → redirect to /login
/login: "Sign in with Google" button
  → supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: '<origin>/auth/callback' } })
  → Google account picker
  → Google → <origin>/auth/callback?code=…
/auth/callback (route handler):
  exchangeCodeForSession(code) → user object
  if !user.email.endsWith('@digitaliziraj.hr'):
    supabase.auth.admin.deleteUser(user.id)  // clean up unauthorized account
    supabase.auth.signOut()
    redirect → /login?error=wrong-domain
  else:
    set session cookie (handled by @supabase/ssr)
    redirect → /leads
```

## What gets protected

Middleware runs on every request. Allowlist:
- `/login`
- `/auth/callback`
- `/auth/signout` (POST only — clears cookie)
- Next.js internals (`/_next/*`, favicon)

Everything else (pages + API routes) requires a valid session. **No more bypassable `/api/leads`.**

## Domain restriction

Enforced in the auth callback handler, not at the Supabase project level (Supabase doesn't have a built-in "only this domain" toggle on Hobby).

If a non-`@digitaliziraj.hr` user manages to authenticate with Google, we:
1. Read their email from the freshly-issued session
2. Call `supabase.auth.admin.deleteUser(user.id)` so they don't linger as a half-authenticated user record
3. `supabase.auth.signOut()` to clear the cookie
4. Redirect to `/login?error=wrong-domain` with a visible error banner

This means the rejection happens AFTER Google auth (we can't tell Google to reject the user upfront), but the user never reaches any protected page.

## Setup steps Igor takes (one-time)

**Google Cloud Console** (same project as Places API key):
1. APIs & Services → Credentials → Create Credentials → OAuth client ID
2. Type: Web application
3. Authorized redirect URI: `https://snrexkypwfiyvufpiatk.supabase.co/auth/v1/callback`
4. Copy Client ID + Client Secret

**Supabase Dashboard:**
1. Authentication → Providers → Google → enable, paste Client ID + Secret
2. Authentication → URL Configuration → add to Redirect URLs:
   - `http://localhost:3000/auth/callback`
   - `https://fit-leads-hr.vercel.app/auth/callback`

**After deploy succeeds:** Vercel → Project → Settings → Deployment Protection → toggle off (otherwise double-login).

## File-level impact

**New:**
- `app/login/page.tsx` — sign-in landing with Google button + error message
- `app/auth/callback/route.ts` — OAuth callback handler (domain check lives here)
- `app/auth/signout/route.ts` — POST handler that clears the cookie
- `lib/supabase-auth.ts` — `@supabase/ssr` browser + server clients with cookie support
- `middleware.ts` — auth gate (was deleted earlier; recreated)

**Modified:**
- `app/layout.tsx` — top-right shows user email + Sign out (when authenticated)
- `package.json` — add `@supabase/ssr`

**No DB changes.** Supabase Auth's `auth.users` table is separate from our `leads`. Single-user app, no per-row user_id needed.

## Trade-offs accepted

- **Login required for every operation** — no bypass for the API. Curl-based debugging from external machines stops working without auth headers.
- **Domain check happens after Google auth, not before** — we can't tell Google to reject upfront. Means a wrong-domain user briefly authenticates, then gets logged out immediately. Their account is deleted from Supabase.
- **No fallback if Google is down** — single auth provider. If Google has an outage, you can't log in. Acceptable for a personal tool.
- **Session length** — Supabase default is 1 hour with refresh. You won't have to log in often, but sessions don't last forever.

## YAGNI

- Magic-link / passwordless fallback
- Multi-tenant / role-based access
- Account management UI (delete account, change email)
- Row Level Security on `leads` (we use the service role key everywhere, RLS adds friction without security)
- Audit log of sign-ins
- "Remember me" toggle (default behavior is fine)

## Verification

1. Run new SQL migration: NONE (Supabase Auth tables already exist).
2. Visit `/leads` while logged out → redirects to `/login`.
3. Click "Sign in with Google" → see Google account picker.
4. Pick a `@digitaliziraj.hr` account → land on `/leads` with email in nav.
5. Click "Sign out" → returns to `/login`.
6. Try with a `@gmail.com` account → see error on `/login` page, no access granted, no row left in `auth.users`.
7. Curl `https://fit-leads-hr.vercel.app/api/leads` from outside → 401, not 200.
8. Disable Vercel Authentication; confirm only Google login is required.
