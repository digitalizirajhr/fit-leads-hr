// Local unauthenticated API probe.
//
// Usage:
//   AUTH_CHECK_BASE_URL=http://127.0.0.1:3000 npm run check:auth
//
// Requires the app to be running locally. This intentionally sends no cookies.

const baseUrl = process.env.AUTH_CHECK_BASE_URL ?? "http://127.0.0.1:3000";

const probes = [
  { method: "GET", path: "/api/leads" },
  { method: "GET", path: "/api/scrape-runs" },
  {
    method: "POST",
    path: "/api/scrape-runs",
    body: { source: "google", params: { probe: true } },
  },
  {
    method: "POST",
    path: "/api/scrape",
    body: { city: "Zagreb", term: "fitness" },
  },
];

let failed = false;

for (const probe of probes) {
  const res = await fetch(`${baseUrl}${probe.path}`, {
    method: probe.method,
    headers: probe.body ? { "Content-Type": "application/json" } : undefined,
    body: probe.body ? JSON.stringify(probe.body) : undefined,
  });
  const ok = res.status === 401 || res.status === 403;
  console.log(
    `${ok ? "[ok]  " : "[fail]"} ${probe.method} ${probe.path} -> ${res.status}`,
  );
  if (!ok) failed = true;
}

if (failed) process.exit(1);
