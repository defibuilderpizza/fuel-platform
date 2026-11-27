import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { onlineWorkers } from "@/lib/lane";

// Public system status, from what Fuel actually did: every job records each provider attempt
// ({provider, ok, ms}), so success rates and latency come from real traffic, not pings.

export type Level = "operational" | "degraded" | "down" | "idle";
export type Component = { id: string; name: string; group: string; level: Level; detail: string; success_1h: number | null; p50_ms: number | null };
export type Hour = { hour: string; jobs: number; ok: number; rate: number | null };
export type Status = { level: Level; updated_at: string; components: Component[]; hours: Hour[]; jobs_24h: number; success_24h: number | null; p50_ms_24h: number | null };

type Attempt = { provider?: string; ok?: boolean; ms?: number };
type JobRow = { status: string; created_at: string; latency_ms: number | null; attempts: Attempt[] | null };

const pct = (ok: number, n: number) => (n ? Math.round((ok / n) * 1000) / 10 : null);
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function levelFor(ok: number, n: number): Level {
  if (n < 3) return n === 0 ? "idle" : ok === n ? "operational" : "degraded";
  const r = ok / n;
  return r >= 0.95 ? "operational" : r >= 0.6 ? "degraded" : "down";
}
const NAMES: Record<string, string> = { together: "Together AI", runpod: "RunPod", anthropic: "Anthropic (Claude)", openai: "OpenAI (GPT)", "fuel-lane": "Laptop lane" };

let cache: { at: number; v: Status } | null = null;

export async function systemStatus(): Promise<Status> {
  if (cache && Date.now() - cache.at < 30_000) return cache.v;
  const db = supabaseAdmin();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const hourAgo = Date.now() - 3_600_000;

  const t0 = Date.now();
  const [jobsRes, routes, sellers, scan, laptops, checks] = await Promise.all([
    db.from("jobs").select("status, created_at, latency_ms, attempts").gte("created_at", since).neq("status", "running").order("created_at", { ascending: false }).limit(20_000),
    db.from("provider_models").select("provider, enabled").eq("enabled", true),
    db.from("seller_models").select("seller_id, probe_ok, sellers!inner(status, operated_by_fuel)").eq("sellers.status", "approved"),
    db.from("deposit_scan_state").select("scanned_at"),
    onlineWorkers().then((w) => w.length).catch(() => 0),
    // provider canary results from the last 30 minutes (used when a provider has had no traffic)
    db.from("provider_checks").select("provider, ok, ms, checked_at").gte("checked_at", new Date(Date.now() - 30 * 60_000).toISOString()).order("checked_at", { ascending: false }).limit(200),
  ]);
  const lastCheck = new Map<string, { ok: boolean; ms: number | null; checked_at: string }>();
  for (const c of checks.data ?? []) if (!lastCheck.has(c.provider)) lastCheck.set(c.provider, c);
  const dbMs = Date.now() - t0;
  const jobs = (jobsRes.data ?? []) as JobRow[];

  // per-provider attempts in the last hour
  const per = new Map<string, { ok: number; n: number; ms: number[] }>();
  for (const j of jobs) {
    if (Date.parse(j.created_at) < hourAgo) continue;
    for (const a of j.attempts ?? []) {
      if (!a.provider) continue;
      const key = a.provider.startsWith("seller:") ? "sellers" : a.provider;
      const e = per.get(key) ?? { ok: 0, n: 0, ms: [] };
      e.n++;
      if (a.ok) {
        e.ok++;
        if (typeof a.ms === "number") e.ms.push(a.ms);
      }
      per.set(key, e);
    }
  }

  const components: Component[] = [];
  components.push({
    id: "api",
    name: "API",
    group: "Platform",
    level: jobsRes.error ? "down" : "operational",
    detail: jobsRes.error ? "Not responding" : "Accepting requests",
    success_1h: null,
    p50_ms: null,
  });
  components.push({
    id: "database",
    name: "Database",
    group: "Platform",
    level: jobsRes.error ? "down" : dbMs > 3000 ? "degraded" : "operational",
    detail: jobsRes.error ? "Unreachable" : `Responded in ${dbMs} ms`,
    success_1h: null,
    p50_ms: null,
  });

  // hosted providers that currently have routes
  const providers = [...new Set((routes.data ?? []).map((r) => r.provider as string))].filter((p) => !p.startsWith("seller:") && !p.startsWith("mock"));
  for (const p of providers.sort()) {
    const e = per.get(p) ?? { ok: 0, n: 0, ms: [] };
    const check = lastCheck.get(p);
    // No customer traffic: fall back to the latest health check, if there is one.
    const checkAge = check ? Math.max(0, Math.round((Date.now() - Date.parse(check.checked_at)) / 60_000)) : null;
    const level = e.n ? levelFor(e.ok, e.n) : check ? (check.ok ? "operational" : "down") : "idle";
    components.push({
      id: p,
      name: NAMES[p] ?? p,
      group: "Compute",
      level,
      detail: e.n
        ? `${e.n} attempt${e.n === 1 ? "" : "s"} in the last hour`
        : check
          ? `Health check ${check.ok ? `passed${check.ms ? ` (${check.ms} ms)` : ""}` : "failed"} ${checkAge! < 1 ? "just now" : `${checkAge} min ago`}`
          : "No traffic in the last hour",
      success_1h: pct(e.ok, e.n),
      p50_ms: median(e.ms),
    });
  }

  // GPU sellers: passing models of approved sellers
  const sm = sellers.data ?? [];
  const sellerIds = new Set(sm.map((r) => r.seller_id));
  const passing = sm.filter((r) => r.probe_ok).length;
  const houseCount = new Set(sm.filter((r) => (r.sellers as unknown as { operated_by_fuel?: boolean } | null)?.operated_by_fuel).map((r) => r.seller_id)).size;
  const se = per.get("sellers") ?? { ok: 0, n: 0, ms: [] };
  components.push({
    id: "sellers",
    name: "GPU sellers",
    group: "Compute",
    level: sellerIds.size === 0 ? "idle" : passing === 0 ? "down" : se.n ? levelFor(se.ok, se.n) : "operational",
    detail:
      sellerIds.size === 0
        ? "No sellers listed yet"
        : `${sellerIds.size} seller${sellerIds.size === 1 ? "" : "s"}${houseCount ? ` (${houseCount} operated by Fuel)` : ""}, ${passing} of ${sm.length} models passing tests`,
    success_1h: pct(se.ok, se.n),
    p50_ms: median(se.ms),
  });

  const le = per.get("fuel-lane") ?? { ok: 0, n: 0, ms: [] };
  components.push({
    id: "lane",
    name: "Laptop lane",
    group: "Compute",
    level: laptops >= 2 ? (le.n ? levelFor(le.ok, le.n) : "operational") : "idle",
    detail: laptops >= 2 ? `${laptops} laptops online` : laptops === 1 ? "1 laptop online (needs 2 to cross-check)" : "No laptops online",
    success_1h: pct(le.ok, le.n),
    p50_ms: median(le.ms),
  });

  const lastScan = Math.max(0, ...(scan.data ?? []).map((r) => (r.scanned_at ? Date.parse(r.scanned_at) : 0)));
  const scanAge = lastScan ? Math.round((Date.now() - lastScan) / 60_000) : null;
  components.push({
    id: "deposits",
    name: "Deposit detection",
    group: "Payments",
    level: scanAge === null ? "degraded" : scanAge <= 15 ? "operational" : scanAge <= 60 ? "degraded" : "down",
    detail: scanAge === null ? "No scan recorded yet" : `Last scan ${scanAge < 1 ? "under a minute" : `${scanAge} min`} ago · instant confirm always on`,
    success_1h: null,
    p50_ms: null,
  });

  // 24 hourly buckets of job success
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const hours: Hour[] = [];
  for (let i = 23; i >= 0; i--) {
    const start = now.getTime() - i * 3_600_000;
    const inHour = jobs.filter((j) => {
      const t = Date.parse(j.created_at);
      return t >= start && t < start + 3_600_000;
    });
    const ok = inHour.filter((j) => j.status === "succeeded").length;
    hours.push({ hour: new Date(start).toISOString(), jobs: inHour.length, ok, rate: pct(ok, inHour.length) });
  }

  const ok24 = jobs.filter((j) => j.status === "succeeded");
  // Overall: the platform (API, DB) and the ability to route somewhere decide it.
  const platformDown = components.some((c) => c.group === "Platform" && c.level === "down");
  const compute = components.filter((c) => c.group === "Compute" && c.level !== "idle");
  const level: Level = platformDown
    ? "down"
    : compute.length > 0 && compute.every((c) => c.level === "down")
      ? "down"
      : components.some((c) => c.level === "degraded" || c.level === "down")
        ? "degraded"
        : "operational";

  const v: Status = {
    level,
    updated_at: new Date().toISOString(),
    components,
    hours,
    jobs_24h: jobs.length,
    success_24h: pct(ok24.length, jobs.length),
    p50_ms_24h: median(ok24.map((j) => j.latency_ms).filter((x): x is number => typeof x === "number")),
  };
  cache = { at: Date.now(), v };
  return v;
}
