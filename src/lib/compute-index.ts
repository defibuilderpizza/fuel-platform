import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { marketRates } from "@/lib/market";

// Fuel Compute Index (FCI): what chat compute costs, as one number.
//
// Methodology
//  - Universe: every live chat model on Fuel with at least one provider.
//  - Price per model: the cheapest provider's price for a typical job, 3 input tokens per
//    output token: (3 × input + output) / 4, USD per 1M tokens. Provider prices, before
//    Fuel's markup.
//  - Index level: starts at 100. Each new point moves the level by the geometric mean of
//    price relatives (new / old) over models priced in both points (chain-linking), so
//    models being added or retired never make the index jump.
//  - Reference price: the median model price at that point, in USD per 1M tokens.
//  - Points: recorded by the 5-minute cron (at most one per RECORD_EVERY_MS); every point
//    stores its components so any step can be recomputed.

const RECORD_EVERY_MS = 5 * 60_000 - 15_000;
const BASE = 100;

export type IndexPoint = { at: string; level: number; median_usd: number; models: number; matched: number };

export async function currentComponents(): Promise<Record<string, number>> {
  const rates = await marketRates();
  const out: Record<string, number> = {};
  for (const r of rates) {
    if (r.kind !== "chat" || r.providers === 0) continue;
    const p = (r.low.in * 3 + r.low.out) / 4;
    if (p > 0 && Number.isFinite(p)) out[r.model] = Math.round(p * 1e6) / 1e6;
  }
  return out;
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Chain-link: geometric mean of price relatives over the models in both snapshots. */
export function linkedLevel(prevLevel: number, prev: Record<string, number>, next: Record<string, number>) {
  const common = Object.keys(next).filter((m) => prev[m] > 0 && next[m] > 0);
  if (common.length === 0) return { level: prevLevel, matched: 0 };
  const meanLog = common.reduce((t, m) => t + Math.log(next[m] / prev[m]), 0) / common.length;
  return { level: Math.round(prevLevel * Math.exp(meanLog) * 1e4) / 1e4, matched: common.length };
}

/** Record a point if the last one is old enough. Returns what happened. */
export async function recordIndexPoint(force = false) {
  const db = supabaseAdmin();
  const { data: last } = await db.from("compute_index_points").select("at, level, components").order("at", { ascending: false }).limit(1).maybeSingle();
  if (!force && last && Date.now() - Date.parse(last.at) < RECORD_EVERY_MS) return { recorded: false, reason: "recent" };
  const components = await currentComponents();
  const prices = Object.values(components);
  if (prices.length === 0) return { recorded: false, reason: "no_prices" };
  const { level, matched } = last ? linkedLevel(Number(last.level), last.components as Record<string, number>, components) : { level: BASE, matched: 0 };
  const row = { level, median_usd: Math.round(median(prices) * 1e6) / 1e6, models: prices.length, matched, components };
  const { error } = await db.from("compute_index_points").insert(row);
  if (error) return { recorded: false, reason: error.message };
  cache = null;
  return { recorded: true, level, models: prices.length };
}

let cache: { at: number; v: Awaited<ReturnType<typeof loadIndex>> } | null = null;

async function loadIndex(days: number) {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await db.from("compute_index_points").select("at, level, median_usd, models, matched").gte("at", since).order("at", { ascending: true }).limit(10_000);
  const pts = (data ?? []).map((r) => ({ at: r.at, level: Number(r.level), median_usd: Number(r.median_usd), models: r.models, matched: r.matched }));
  // Down-sample to at most ~240 points for charts: keep the last point in each bucket.
  const bucketMs = Math.max(5 * 60_000, Math.ceil((days * 86_400_000) / 240));
  const series: IndexPoint[] = [];
  for (const p of pts) {
    const b = Math.floor(Date.parse(p.at) / bucketMs);
    const prev = series[series.length - 1];
    if (prev && Math.floor(Date.parse(prev.at) / bucketMs) === b) series[series.length - 1] = p;
    else series.push(p);
  }
  const latest = pts[pts.length - 1] ?? null;
  const changeOver = (ms: number) => {
    if (!latest) return null;
    const cutoff = Date.parse(latest.at) - ms;
    const base = [...pts].reverse().find((p) => Date.parse(p.at) <= cutoff);
    return base ? Math.round((latest.level / base.level - 1) * 10_000) / 100 : null;
  };
  const { data: first } = await db.from("compute_index_points").select("at").order("at", { ascending: true }).limit(1).maybeSingle();
  return {
    name: "Fuel Compute Index",
    base: BASE,
    started_at: first?.at ?? null,
    latest,
    change_pct: { "24h": changeOver(86_400_000), "7d": changeOver(7 * 86_400_000), "30d": changeOver(30 * 86_400_000) },
    series,
  };
}

export async function computeIndex(days = 30) {
  if (days === 30 && cache && Date.now() - cache.at < 60_000) return cache.v;
  const v = await loadIndex(days);
  if (days === 30) cache = { at: Date.now(), v };
  return v;
}
