"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OutreachMethod } from "@/lib/types";

const METHODS: { value: OutreachMethod; label: string }[] = [
  { value: "instagram_dm", label: "Instagram DM" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "other", label: "Other" },
];

export function AddOutreachForm({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [method, setMethod] = useState<OutreachMethod>("instagram_dm");
  const [message, setMessage] = useState("");
  const [response, setResponse] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!message.trim()) {
      setError("Message can't be empty.");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/leads/${leadId}/outreach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method,
          message: message.trim(),
          response: response.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Save failed (${res.status})`);
        return;
      }
      // Reset and refresh — new entry will appear at the top of the log,
      // and the lead's contacted_at / last_contact_method / status (if "new")
      // will reflect the side effects.
      setMessage("");
      setResponse("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">Add outreach entry</p>

      <div className="space-y-1.5">
        <Label className="text-xs">Method</Label>
        <Select value={method} onValueChange={(v) => setMethod(v as OutreachMethod)}>
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METHODS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Message</Label>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What did you send?"
          className="min-h-[80px]"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Response (optional)</Label>
        <Textarea
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          placeholder="What did they say back?"
          className="min-h-[60px]"
        />
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isPending || !message.trim()}>
          {isPending ? "Saving…" : "Save entry"}
        </Button>
      </div>
    </form>
  );
}
