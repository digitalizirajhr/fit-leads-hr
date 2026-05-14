"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

type Format = "csv" | "json";

interface Props {
  selectedIds: string[];
  disabled?: boolean;
}

export function ExportDialog({ selectedIds, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>("csv");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: selectedIds, format }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      // Trigger the browser download via a synthetic <a download>.
      const blob = await res.blob();
      const filename =
        res.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? `fit-leads.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        // Render the trigger as an inline Button via the render prop pattern
        // (base-ui Dialog.Trigger lets us swap the element it renders).
        render={
          <Button variant="outline" size="sm" disabled={disabled || selectedIds.length === 0}>
            {selectedIds.length > 0
              ? `Export selected (${selectedIds.length})`
              : "Export selected"}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export {selectedIds.length} lead{selectedIds.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            CSV opens cleanly in Excel — diacritics preserved (UTF-8 BOM).
            JSON is pretty-printed for re-imports or scripts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <Label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="format"
              value="csv"
              checked={format === "csv"}
              onChange={() => setFormat("csv")}
            />
            CSV (.csv)
          </Label>
          <Label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="format"
              value="json"
              checked={format === "json"}
              onChange={() => setFormat("json")}
            />
            JSON (.json)
          </Label>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={downloading}>
            Cancel
          </Button>
          <Button onClick={download} disabled={downloading || selectedIds.length === 0}>
            {downloading ? "Downloading…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
