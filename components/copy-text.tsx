"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Click-to-copy text. Used for phone numbers in the leads table and detail
 * page. Shows a brief "copied" hint after a successful write.
 *
 * Lives in its own client component because the parent (e.g. the lead detail
 * page) is a server component and can't carry onClick handlers.
 */
export function CopyText({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Older browsers / iframes may block clipboard. Silently no-op.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied!" : "Click to copy"}
      className={cn("text-left hover:underline underline-offset-4", className)}
    >
      {children ?? value}
      {copied ? <span className="ml-2 text-xs text-muted-foreground">copied</span> : null}
    </button>
  );
}
