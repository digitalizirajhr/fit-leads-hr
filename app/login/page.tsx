"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getBrowserAuth } from "@/lib/supabase-auth-browser";

const ALLOWED_DOMAIN_HUMAN = "@digitaliziraj.hr";

export default function LoginPage() {
  // Search params need a Suspense boundary in App Router.
  return (
    <Suspense
      fallback={<main className="mx-auto p-6 text-center text-muted-foreground">Loading…</main>}
    >
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
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
        // Hint to Google: prefer the @digitaliziraj.hr account if user has
        // multiple Google accounts. Actual enforcement still happens in our
        // callback — Google's `hd` is a UX hint, not a security check.
        queryParams: { hd: "digitaliziraj.hr" },
      },
    });
    if (error) {
      setOauthError(error.message);
      setBusy(false);
    }
    // On success the browser navigates to Google; nothing more to do here.
  }

  const errorMessage =
    errorParam === "wrong-domain"
      ? `Only ${ALLOWED_DOMAIN_HUMAN} accounts are allowed. Try again with the right account.`
      : errorParam === "no-code"
        ? "OAuth callback didn't include a code. Try again."
        : errorParam === "exchange"
          ? "Couldn't complete sign-in. Try again."
          : errorParam === "config"
            ? "Server is misconfigured: Supabase env vars missing. Contact the maintainer."
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
