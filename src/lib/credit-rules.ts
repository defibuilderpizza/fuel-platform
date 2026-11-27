import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { microToUsd } from "@/lib/money";
import { buyCredits, creditConfig, CREDITS_OFF, MICRO_UNITS, quote } from "@/lib/credits";
import { cancelOrder, placeOrder } from "@/lib/credit-market";
import { isTier, type Tier } from "@/lib/credit-tiers";

// Standing rules: Fuel trades credits for you on the cron (every 5 minutes), only within the
// limits you set. Rules never leave a buy order resting: they take what's for sale at or under
// your max price (book first, then Fuel), and cancel the rest.
//   keep_min            holdings of a tier below min_credits → buy back up to target_credits
//   sell_before_expiry  days_before a series expires → list what you hold of it at min_price

export const MAX_RULES = 10;

export type RuleInput = {
  kind: "keep_min" | "sell_before_expiry";
  tier: Tier;
  min_credits?: number;
  target_credits?: number;
  max_price_usd?: number;
  min_price_usd?: number;
  days_before?: number;
};

type Row = {
  id: string;
  wallet: string;
  kind: RuleInput["kind"];
  tier: Tier;
  min_credits: number | null;
  target_credits: number | null;
  max_price_micro: number | null;
  min_price_micro: number | null;
  days_before: number | null;
  active: boolean;
  last_run_at: string | null;
  last_result: string | null;
  created_at: string;
};

const view = (r: Row) => ({
  id: r.id,
  kind: r.kind,
  tier: r.tier,
  ...(r.kind === "keep_min"
    ? { min_credits: Number(r.min_credits), target_credits: Number(r.target_credits), max_price_usd: microToUsd(r.max_price_micro) }
    : { days_before: r.days_before, min_price_usd: microToUsd(r.min_price_micro) }),
  active: r.active,
  last_run_at: r.last_run_at,
  last_result: r.last_result,
  created_at: r.created_at,
});

/** Checks a rule from the API. Returns an error message, or the row to insert. */
export function validateRule(b: Record<string, unknown> | null): { error: string } | { row: Omit<Row, "id" | "wallet" | "active" | "last_run_at" | "last_result" | "created_at"> } {
  if (!b) return { error: "Send a JSON body." };
  if (!isTier(b.tier)) return { error: "'tier' must be max, pro, open or lane." };
  const num = (k: string) => (typeof b[k] === "number" && Number.isFinite(b[k]) ? (b[k] as number) : NaN);
  if (b.kind === "keep_min") {
    const min = num("min_credits");
    const target = num("target_credits");
    const max = num("max_price_usd");
    if (!(min >= 0.01) || min > 100_000) return { error: "'min_credits' must be between 0.01 and 100000." };
    if (!(target > min) || target > 100_000) return { error: "'target_credits' must be above min_credits (and at most 100000)." };
    if (!(max > 0) || max > 1000) return { error: "'max_price_usd' (most you'll pay per credit, fees included) must be above 0." };
    return { row: { kind: "keep_min", tier: b.tier, min_credits: min, target_credits: target, max_price_micro: Math.round(max * 1e6), min_price_micro: null, days_before: null } };
  }
  if (b.kind === "sell_before_expiry") {
    const days = num("days_before");
    const min = num("min_price_usd");
    if (!Number.isInteger(days) || days < 1 || days > 80) return { error: "'days_before' must be a whole number of days from 1 to 80." };
    if (!(min > 0) || min > 1000) return { error: "'min_price_usd' (least you'll sell a credit for) must be above 0." };
    return { row: { kind: "sell_before_expiry", tier: b.tier, min_credits: null, target_credits: null, max_price_micro: null, min_price_micro: Math.round(min * 1e6), days_before: days } };
  }
  return { error: "'kind' must be keep_min or sell_before_expiry." };
}

export async function listRules(wallet: string) {
  const { data } = await supabaseAdmin().from("credit_rules").select("*").eq("wallet", wallet).order("created_at");
  return (data ?? []).map((r) => view(r as Row));
}

export async function createRule(wallet: string, row: Omit<Row, "id" | "wallet" | "active" | "last_run_at" | "last_result" | "created_at">) {
  if (!(await creditConfig()).enabled) return { ok: false as const, message: `${CREDITS_OFF}.` };
  const db = supabaseAdmin();
  const { count } = await db.from("credit_rules").select("id", { count: "exact", head: true }).eq("wallet", wallet).eq("active", true);
  if ((count ?? 0) >= MAX_RULES) return { ok: false as const, message: `You have ${MAX_RULES} rules; delete one first.` };
  const { data, error } = await db.from("credit_rules").insert({ ...row, wallet }).select("*").single();
  if (error || !data) return { ok: false as const, message: "Could not save the rule." };
  return { ok: true as const, rule: view(data as Row) };
}

export async function deleteRule(wallet: string, id: string) {
  const { data } = await supabaseAdmin().from("credit_rules").delete().eq("id", id).eq("wallet", wallet).select("id");
  return (data ?? []).length > 0;
}

/** Credits a wallet holds of a tier (unexpired lots), per series. */
async function holdings(wallet: string, tier: Tier) {
  const { data } = await supabaseAdmin()
    .from("credit_lots")
    .select("units_left_micro, series_id, credit_series!inner(tier, expires_at)")
    .eq("wallet", wallet)
    .eq("status", "open")
    .eq("credit_series.tier", tier)
    .gt("expires_at", new Date().toISOString());
  const by = new Map<string, { units: number; expires_at: string }>();
  for (const l of data ?? []) {
    const s = l.credit_series as unknown as { expires_at: string };
    const cur = by.get(l.series_id as string) ?? { units: 0, expires_at: s.expires_at };
    cur.units += Number(l.units_left_micro);
    by.set(l.series_id as string, cur);
  }
  return by;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

async function runKeepMin(r: Row): Promise<string> {
  const have = [...(await holdings(r.wallet, r.tier)).values()].reduce((t, x) => t + x.units, 0) / MICRO_UNITS;
  if (have >= Number(r.min_credits)) return `holding ${round6(have)}, nothing to do`;
  let need = round6(Number(r.target_credits) - have);
  const maxPx = Number(r.max_price_micro);
  const cfg = await creditConfig();
  const done: string[] = [];

  // 1. The book: latest-expiring series first. The order trades at resting prices; the rest is cancelled.
  if (cfg.enabled && cfg.trading_enabled) {
    const { data: series } = await supabaseAdmin()
      .from("credit_series")
      .select("id")
      .eq("tier", r.tier)
      .gt("expires_at", new Date(Date.now() + 86_400_000).toISOString())
      .order("expires_at", { ascending: false });
    for (const s of series ?? []) {
      if (need < 0.01) break;
      // The book price plus the trade fee must stay within the max.
      const limit = Math.floor(maxPx / (1 + cfg.trade_fee_bps / 10_000));
      const { data: ask } = await supabaseAdmin().from("credit_orders").select("price_micro").eq("series_id", s.id).eq("side", "sell").eq("status", "open").neq("wallet", r.wallet).lte("price_micro", limit).limit(1);
      if (!ask?.length) continue;
      const o = await placeOrder(r.wallet, s.id as string, "buy", limit / 1e6, need);
      if (!o.ok) {
        done.push(`book ${s.id}: ${o.code}`);
        continue;
      }
      if (o.status === "open") await cancelOrder(r.wallet, o.order_id);
      if (o.filled_credits > 0) done.push(`bought ${o.filled_credits} on the book (${s.id})`);
      need = round6(need - o.filled_credits);
    }
  }

  // 2. Fuel, if its all-in price per credit is within the max.
  if (need >= 0.01) {
    const q = await quote(need, r.tier);
    if ("error" in q) done.push(q.error!);
    else if (!q.st.selling.open) done.push(`Fuel not selling: ${q.st.selling.reason}`);
    else if (q.total / need > maxPx) done.push(`Fuel's price $${(q.total / need / 1e6).toFixed(4)} is above your max`);
    else {
      const b = await buyCredits(r.wallet, need, r.tier);
      done.push(b.ok ? `bought ${need} from Fuel for $${b.paid_usd}` : `Fuel: ${b.code}`);
    }
  }
  return done.join("; ") || "nothing for sale within your max price";
}

async function runSellBeforeExpiry(r: Row): Promise<string> {
  const cutoff = Date.now() + Number(r.days_before) * 86_400_000;
  const done: string[] = [];
  for (const [series, h] of await holdings(r.wallet, r.tier)) {
    const exp = Date.parse(h.expires_at);
    if (exp > cutoff || exp <= Date.now() + 3_600_000) continue;
    const credits = Math.floor(h.units / 10_000) / 100; // whole hundredths
    if (credits < 0.01) continue;
    const o = await placeOrder(r.wallet, series, "sell", Number(r.min_price_micro) / 1e6, credits);
    done.push(o.ok ? `listed ${credits} of ${series} at $${microToUsd(r.min_price_micro)} (${o.filled_credits} sold at once)` : `${series}: ${o.code}`);
  }
  return done.join("; ") || "nothing near expiry";
}

/** Called by the cron: runs every active rule once. */
export async function runCreditRules() {
  const cfg = await creditConfig();
  if (!cfg.enabled) return { ran: 0, reason: "credits off" };
  const { data } = await supabaseAdmin().from("credit_rules").select("*").eq("active", true).order("last_run_at", { ascending: true, nullsFirst: true }).limit(200);
  let ran = 0;
  for (const r of (data ?? []) as Row[]) {
    let result: string;
    try {
      result = r.kind === "keep_min" ? await runKeepMin(r) : await runSellBeforeExpiry(r);
    } catch (e) {
      result = `error: ${String((e as Error).message ?? e).slice(0, 120)}`;
    }
    await supabaseAdmin().from("credit_rules").update({ last_run_at: new Date().toISOString(), last_result: result.slice(0, 500) }).eq("id", r.id);
    ran++;
  }
  return { ran };
}
