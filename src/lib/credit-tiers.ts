import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { markupBps } from "@/lib/money";
import { marketRates, type Rate } from "@/lib/market";
import type { Kind } from "@/lib/providers";

// Tiered compute credits, counted in tokens (see migration 0024).
//
// 1 credit = at least 1M tokens at a 3:1 input:output mix on any model of its tier. A tier's
// price is what 1M such tokens cost on its dearest model (dearest provider, incl. Fuel's markup),
// so that model gets exactly 1M tokens per credit and cheaper ones get more. A job uses
// (its price ÷ the tier price) credits.

export const TIERS = ["max", "pro", "open", "lane"] as const;
export type Tier = (typeof TIERS)[number];
/** A series id: month and tier, e.g. 2026-12-pro. */
export const SERIES_RE = /^\d{4}-\d{2}-(max|pro|open|lane)$/;
export const isTier = (t: unknown): t is Tier => typeof t === "string" && (TIERS as readonly string[]).includes(t);

/**
 * Tiers are price bands on provider cost (3:1 mix, USD per 1M tokens), so a credit's 1M-token
 * promise stays close for every model in it: Max from $7; Pro for other closed models and open
 * models from $1.50 (the big ones, e.g. Kimi K3); Open below $1.50.
 */
const MAX_TIER_FROM_USD = 7;
const PRO_TIER_FROM_USD = 1.5;
const CLOSED = /^(anthropic|openai)\//;

const mix = (kind: Kind, p: { in: number; out: number }) => (kind === "embedding" ? p.in : p.in * 0.75 + p.out * 0.25);
/** Most a job on this model is charged per 1M tokens: its dearest provider + markup (or a fixed agent price, like the lane's). */
const maxCharge = (r: Rate, m: number) => ({ in: Math.max(r.high.in * m, r.agent_price.in), out: Math.max(r.high.out * m, r.agent_price.out) });

/** The tier a model's credits come from. */
export function tierOf(model: string, kind: Kind, providerCost?: { in: number; out: number }): Tier {
  if (kind === "embedding") return "lane";
  const cost = providerCost ? mix(kind, providerCost) : 0;
  if (cost >= MAX_TIER_FROM_USD) return "max";
  if (CLOSED.test(model) || cost >= PRO_TIER_FROM_USD) return "pro";
  return "open";
}

export type TierModel = {
  model: string;
  kind: Kind;
  tokens_per_credit: number; // at a 3:1 mix (embeddings: input tokens)
  input_tokens_per_credit: number; // if the job were all input
  output_tokens_per_credit: number | null; // if it were all output (null for embeddings)
};
export type TierInfo = { id: Tier; name: string; description: string; price_usd: number | null; models: TierModel[] };

type Table = { at: number; byModel: Map<string, Tier>; price: Map<Tier, number>; rates: Rate[] };
let cache: Table | null = null;

/** Tier of every live model and each tier's price (USD micro per credit). Cached for a minute. */
export async function tierTable(fresh = false): Promise<Table> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache;
  const rates = await marketRates();
  const m = 1 + markupBps() / 10_000;
  const byModel = new Map<string, Tier>();
  const price = new Map<Tier, number>();
  for (const r of rates) {
    const kind = r.kind as Kind;
    const tier = tierOf(r.model, kind, r.high);
    byModel.set(r.model, tier);
    // Dearest provider of the model, with markup: a job can fail over to it.
    const usd = mix(kind, maxCharge(r, m));
    price.set(tier, Math.max(price.get(tier) ?? 0, Math.ceil(usd * 1e6)));
  }
  cache = { at: Date.now(), byModel, price, rates };
  return cache;
}

/** Writes today's tier prices to the database (expiry and caps use them). */
export async function syncTierPrices() {
  const t = await tierTable(true);
  const db = supabaseAdmin();
  const { data } = await db.from("credit_tiers").select("id, price_micro");
  const changed = [];
  for (const row of data ?? []) {
    const p = t.price.get(row.id as Tier) ?? 0;
    if (p > 0 && p !== Number(row.price_micro)) {
      await db.from("credit_tiers").update({ price_micro: p, price_at: new Date().toISOString() }).eq("id", row.id);
      changed.push(row.id);
    }
  }
  return { prices: Object.fromEntries([...t.price.entries()].map(([k, v]) => [k, v / 1e6])), changed };
}

export async function tierPrice(tier: Tier) {
  return (await tierTable()).price.get(tier) ?? 0;
}

/** Every tier: price per credit and exactly how many tokens a credit buys on each model. */
export async function tiersOverview(): Promise<TierInfo[]> {
  const t = await tierTable();
  const { data } = await supabaseAdmin().from("credit_tiers").select("id, name, description, sort, active").order("sort");
  const m = 1 + markupBps() / 10_000;
  return (data ?? [])
    .filter((row) => row.active && isTier(row.id))
    .map((row) => {
      const tier = row.id as Tier;
      const p = t.price.get(tier) ?? 0;
      const models = t.rates
        .filter((r) => t.byModel.get(r.model) === tier)
        .map((r) => {
          const kind = r.kind as Kind;
          // What a job on the model is charged at most per 1M tokens (dearest provider + markup).
          const { in: inP, out: outP } = maxCharge(r, m);
          const usd = p / 1e6;
          return {
            model: r.model,
            kind,
            tokens_per_credit: Math.floor((usd / mix(kind, { in: inP, out: outP })) * 1e6),
            input_tokens_per_credit: inP > 0 ? Math.floor((usd / inP) * 1e6) : 0,
            output_tokens_per_credit: kind === "embedding" || outP <= 0 ? null : Math.floor((usd / outP) * 1e6),
          };
        })
        .sort((a, b) => a.tokens_per_credit - b.tokens_per_credit);
      return { id: tier, name: row.name as string, description: row.description as string, price_usd: p > 0 ? p / 1e6 : null, models };
    });
}

// ── Paying jobs with credits ─────────────────────────────────────────────────────────────────

export type CreditPay = { tier: Tier; price_micro: number };

/**
 * Whether this job should try credits: the caller holds unexpired credits of the model's tier
 * and didn't turn credits off for the request (header x-fuel-credits: off).
 */
export async function creditPayFor(req: Request | null, wallet: string, model: string, kind: Kind): Promise<CreditPay | null> {
  if (req && /^(off|false|0|no)$/i.test(req.headers.get("x-fuel-credits") ?? "")) return null;
  const t = await tierTable();
  const tier = t.byModel.get(model) ?? tierOf(model, kind);
  const price = t.price.get(tier) ?? 0;
  if (price <= 0) return null;
  const { data } = await supabaseAdmin()
    .from("credit_lots")
    .select("id, credit_series!inner(tier)")
    .eq("wallet", wallet)
    .eq("status", "open")
    .eq("credit_series.tier", tier)
    .gt("expires_at", new Date().toISOString())
    .limit(1);
  return data?.length ? { tier, price_micro: price } : null;
}

/**
 * Reserves a job, paid with credits when `pay` is set and the caller has enough of them
 * (otherwise from the balance as usual). Returns fuel_reserve's result and whether credits pay.
 */
export async function reserveJob(a: { jobId: string; wallet: string; model: string; kind: Kind; hold: number; streamed: boolean; pay: CreditPay | null }) {
  const db = supabaseAdmin();
  if (a.pay) {
    const { data, error } = await db.rpc("fuel_credit_job_reserve", {
      p_job: a.jobId,
      p_wallet: a.wallet,
      p_model: a.model,
      p_kind: a.kind,
      p_hold: a.hold,
      p_streamed: a.streamed,
      p_tier: a.pay.tier,
      p_price_micro: a.pay.price_micro,
    });
    if (error) return { result: null, error: error.message, credits: null };
    if (data !== "no_credits") return { result: String(data), error: null, credits: data === "ok" ? a.pay : null };
  }
  const { data, error } = await db.rpc("fuel_reserve", { p_job: a.jobId, p_wallet: a.wallet, p_model: a.model, p_kind: a.kind, p_hold: a.hold, p_streamed: a.streamed });
  if (error) return { result: null, error: error.message, credits: null };
  return { result: String(data), error: null, credits: null };
}

/** Credits a settled job used (for its receipt). */
export async function creditsUsed(jobId: string) {
  const { data } = await supabaseAdmin().from("credit_job_holds").select("tier, units_used").eq("job_id", jobId).maybeSingle();
  return data ? { tier: data.tier as Tier, credits: Number(data.units_used ?? 0) / 1e6 } : null;
}
