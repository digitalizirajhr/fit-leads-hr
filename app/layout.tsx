import type { Metadata } from "next";
import Link from "next/link";
import localFont from "next/font/local";
import "./globals.css";
import { cn } from "@/lib/utils";
import { getServerAuth } from "@/lib/supabase-auth-server";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "fit-leads-hr",
  description: "Personal lead-gen CRM for Croatian fitness coaches",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read the auth user so we can show their email + a Sign-out button when
  // logged in. Done server-side so there's no flash of "logged out" nav state.
  const supabase = await getServerAuth();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html lang="hr" className={cn("dark", geistSans.variable, geistMono.variable)}>
      <body className="antialiased font-sans bg-background text-foreground">
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
        {children}
      </body>
    </html>
  );
}
