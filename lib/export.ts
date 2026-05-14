// CSV / JSON export helpers used by /api/export.
//
// Croatian diacritics MUST round-trip cleanly. CSV is prefixed with a UTF-8
// BOM (﻿) so Excel for Windows opens it as UTF-8 instead of guessing
// the codepage and mangling Č / ć / ž / š / đ.

import type { Lead } from "@/lib/types";

// Columns + display headers for the CSV. Order is intentional — phone first
// for cold outreach, then identifying fields, then CRM fields at the end.
const CSV_COLUMNS: ReadonlyArray<{ key: keyof Lead; header: string }> = [
  { key: "name", header: "Name" },
  { key: "phone", header: "Phone" },
  { key: "current_website", header: "Website" },
  { key: "city", header: "City" },
  { key: "address", header: "Address" },
  { key: "google_rating", header: "Google rating" },
  { key: "google_review_count", header: "Google reviews" },
  { key: "instagram_handle", header: "IG handle" },
  { key: "instagram_followers", header: "IG followers" },
  { key: "instagram_is_active", header: "IG active (30d)" },
  { key: "instagram_last_post_at", header: "IG last post" },
  { key: "has_real_website", header: "Has real website" },
  { key: "qualified", header: "Qualified" },
  { key: "status", header: "Status" },
  { key: "priority", header: "Priority" },
  { key: "notes", header: "Notes" },
  { key: "contacted_at", header: "Last contacted" },
  { key: "last_contact_method", header: "Last method" },
];

/** RFC-4180-ish CSV cell escaping: quote anything containing , " or newline. */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize leads to CSV with UTF-8 BOM. Returns a string ready to be sent
 * with Content-Type: text/csv; charset=utf-8.
 */
export function toCsv(leads: Lead[]): string {
  const header = CSV_COLUMNS.map((c) => escapeCell(c.header)).join(",");
  const rows = leads.map((lead) =>
    CSV_COLUMNS.map((c) => escapeCell(lead[c.key])).join(","),
  );
  // ﻿ = UTF-8 BOM. \r\n line endings make Excel happiest on Windows.
  return "﻿" + [header, ...rows].join("\r\n") + "\r\n";
}

/** Pretty-printed JSON. */
export function toJson(leads: Lead[]): string {
  return JSON.stringify(leads, null, 2);
}

/** "fit-leads-2026-05-14.csv" — date in local time. */
export function exportFilename(format: "csv" | "json", at: Date = new Date()): string {
  const yyyy = at.getFullYear();
  const mm = String(at.getMonth() + 1).padStart(2, "0");
  const dd = String(at.getDate()).padStart(2, "0");
  return `fit-leads-${yyyy}-${mm}-${dd}.${format}`;
}
