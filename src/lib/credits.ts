import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { markupBps, microToUsd } from "@/lib/money";
import { marketRates } from "@/lib/market";
import { syncTierPrices, tierTable, tiersOverview, type Tier } from "@/lib/credit-tiers";

// Compute credits. See migration 0012 for the reserve rules and 0024 for tiers: a credit belongs
// to a tier and is worth at least 1M tokens on that tier's models (priced from live provider
// prices, see credit-tiers.ts). The Fuel Compute Index level is still recorded with each lot.

export const MICRO_UNITS = 1_000_000;
const STALE_INDEX_MS = 60 * 60_000; // no sales on a price older than an hour

export type CreditConfig = {
  enabled: boolean;
  unit_base_usd: number;
  cap_usd: number;
  wallet_cap_usd: number;
  fee_bps: number;
  premium_max_bps: number;
  mint_min_coverage: number;
  redeem_limit_coverage: number;
  redeem_daily_usd: number;
  expiry_days: number;
  reserve_micro: number;
  forward_bond_pct: number;
  forward_max_premium_pct: number;
  forward_breach_hours: number;
  promise_share: number;
  require_locked_capacity: boolean;
  house_market: boolean;
  house_credit_discount_bps: number;
  trading_enabled: boolean;
  trade_fee_bps: number;
  expiry_months: number;
  trade_down_fee_bps: number;
};

/** What callers see while credits are off (they open after the Fuel token launch). */
export const CREDITS_OFF = "Compute credits open after the Fuel token launch";

export async function creditConfig(): Promise<CreditConfig> {
  const { data } = await supabaseAdmin().from("credit_config").select("*").eq("id", 1).single();
  return {
    enabled: !!data?.enabled,
    unit_base_usd: Number(data?.unit_base_usd ?? 0.5625),
    cap_usd: Number(data?.cap_usd ?? 0),
    wallet_cap_usd: Number(data?.wallet_cap_usd ?? 0),
    fee_bps: Number(data?.fee_bps ?? 100),
    premium_max_bps: Number(data?.premium_max_bps ?? 300),
    mint_min_coverage: Number(data?.mint_min_coverage ?? 1.25),
    redeem_limit_coverage: Number(data?.redeem_limit_coverage ?? 1.1),
    redeem_daily_usd: Number(data?.redeem_daily_usd ?? 50),
    expiry_days: Number(data?.expiry_days ?? 90),
    reserve_micro: Number(data?.reserve_micro ?? 0),
    forward_bond_pct: Number(data?.forward_bond_pct ?? 0.2),
    forward_max_premium_pct: Number(data?.forward_max_premium_pct ?? 5),
    forward_breach_hours: Number(data?.forward_breach_hours ?? 24),
    promise_share: Number(data?.promise_share ?? 0.35),
    require_locked_capacity: data?.require_locked_capacity !== false,
    house_market: data?.house_market !== false,
    house_credit_discount_bps: Number(data?.house_credit_discount_bps ?? 1000),
    trading_enabled: !!data?.trading_enabled,
    trade_fee_bps: Number(data?.trade_fee_bps ?? 50),
    expiry_months: Number(data?.expiry_months ?? 3),
    trade_down_fee_bps: Number(data?.trade_down_fee_bps ?? 500),
  };
}

/** Latest index level and when it was recorded. */
async function latestLevel() {
  const { data } = await supabaseAdmin().from("compute_index_points").select("at, level").order("at", { ascending: false }).limit(1).maybeSingle();
  return data ? { level: Number(data.level), at: data.at as string } : null;
}

/** Value of one credit now: unit_base_usd × level / 100. */
export async function unitPrice(cfg?: CreditConfig) {
  const c = cfg ?? (await creditConfig());
  const l = await latestLevel();
  if (!l) return null;
  return { level: l.level, at: l.at, unit_usd: Math.round(c.unit_base_usd * (l.level / 100) * 1e8) / 1e8, stale: Date.now() - Date.parse(l.at) > STALE_INDEX_MS };
}

export type CreditState = Awaited<ReturnType<typeof creditState>>;

const typicalPrice = (inP: number, outP: number) => (inP * 3 + outP) / 4; // USD per 1M tokens, 3:1 job

/**
 * Compute Fuel has locked in for credits:
 *  - Fuel-operated GPUs (prepaid rentals): tokens they can still serve before locked_until,
 *    × promise_share, valued at today's market price for their model (the cheapest of their models).
 *  - Active capacity contracts: volume left, valued at today's market price.
 * Value moves with market prices, so it's a hedge: if compute gets dearer, so does what it's worth.
 */
export async function lockedCapacity(cfg: CreditConfig) {
  const db = supabaseAdmin();
  const nowIso = new Date().toISOString();
  const [{ data: gpus }, { data: contracts }, rates] = await Promise.all([
    db.from("sellers").select("id, name, status, locked_cost_hr, locked_tps, locked_until").eq("operated_by_fuel", true).gt("locked_until", nowIso),
    db.from("capacity_contracts").select("model, volume_mtok, used_mtok, ceiling_in, ceiling_out, ends_at").eq("status", "active"),
    marketRates(),
  ]);
  const spot = new Map(rates.map((r) => [r.model, typicalPrice(r.low.in, r.low.out)]));
  const out = [];
  for (const g of gpus ?? []) {
    if (!g.locked_tps) continue;
    const { data: models } = await db.from("seller_models").select("model, input_per_mtok, output_per_mtok, probe_ok").eq("seller_id", g.id).eq("kind", "chat");
    const priced = (models ?? []).map((m) => ({ model: m.model as string, ok: !!m.probe_ok, price: spot.get(m.model) ?? typicalPrice(Number(m.input_per_mtok), Number(m.output_per_mtok)) }));
    const live = g.status === "approved" && priced.some((m) => m.ok);
    const hours = Math.max(0, (Date.parse(g.locked_until as string) - Date.now()) / 3_600_000);
    const fullMtok = (Number(g.locked_tps) * 3600 * hours) / 1e6;
    const promisedMtok = fullMtok * cfg.promise_share;
    const price = priced.length ? Math.min(...priced.map((m) => m.price)) : 0;
    // What it actually did in the last 24 h: credit jobs vs spare capacity sold to the market.
    const { data: jobs } = await db
      .from("jobs")
      .select("credit_funded, input_tokens, output_tokens, price_micro")
      .eq("provider", `seller:${g.id}`)
      .eq("status", "succeeded")
      .gte("created_at", new Date(Date.now() - 86_400_000).toISOString())
      .limit(50_000);
    const split = (credit: boolean) => {
      const js = (jobs ?? []).filter((j) => !!j.credit_funded === credit);
      return {
        mtok: Math.round((js.reduce((t, j) => t + Number(j.input_tokens ?? 0) + Number(j.output_tokens ?? 0), 0) / 1e6) * 1000) / 1000,
        usd: Math.round(js.reduce((t, j) => t + Number(j.price_micro ?? 0), 0)) / 1e6,
      };
    };
    out.push({
      kind: "gpu" as const,
      credit_24h: split(true),
      market_24h: split(false),
      name: g.name as string,
      models: priced.map((m) => m.model),
      live,
      until: g.locked_until as string,
      cost_hr: g.locked_cost_hr === null ? null : Number(g.locked_cost_hr),
      capacity_mtok: Math.round(fullMtok),
      promised_mtok: Math.round(promisedMtok),
      price_per_mtok: Math.round(price * 1e4) / 1e4,
      // A GPU that isn't live doesn't back anything until it's fixed.
      value_usd: live ? promisedMtok * price : 0,
    });
  }
  for (const c of contracts ?? []) {
    const left = Math.max(0, Number(c.volume_mtok) - Number(c.used_mtok));
    const price = spot.get(c.model) ?? typicalPrice(Number(c.ceiling_in), Number(c.ceiling_out));
    out.push({ kind: "contract" as const, credit_24h: null, market_24h: null, name: c.model as string, models: [c.model as string], live: true, until: c.ends_at as string, cost_hr: null, capacity_mtok: Math.round(left), promised_mtok: Math.round(left), price_per_mtok: Math.round(price * 1e4) / 1e4, value_usd: left * price });
  }
  const lastUntil = out.reduce((t, x) => Math.max(t, Date.parse(x.until)), 0);
  return { items: out, value_usd: out.reduce((t, x) => t + x.value_usd, 0), until: lastUntil ? new Date(lastUntil).toISOString() : null };
}

/** Everything the admin page needs to judge the reserve and the capacity behind credits. */
export async function creditState() {
  const db = supabaseAdmin();
  const cfg = await creditConfig();
  const [price, locked, table] = await Promise.all([unitPrice(cfg), lockedCapacity(cfg), tierTable()]);
  const [{ data: lots }, { data: sellOrders }] = await Promise.all([
    db.from("credit_lots").select("wallet, units_left_micro, expires_at, unit_usd_at_buy, credit_series(tier)").eq("status", "open"),
    db.from("credit_orders").select("wallet, units_open, price_micro, credit_series(expires_at, tier)").eq("status", "open").eq("side", "sell"),
  ]);
  // Credits waiting in sell orders are still owed by Fuel: count them like held credits.
  const open = [
    ...(lots ?? []).map((l) => ({
      wallet: l.wallet as string,
      units_left_micro: l.units_left_micro,
      expires_at: l.expires_at as string,
      unit_usd_at_buy: Number(l.unit_usd_at_buy),
      tier: (l.credit_series as unknown as { tier: Tier } | null)?.tier ?? "open",
    })),
    ...(sellOrders ?? []).map((o) => ({
      wallet: o.wallet as string,
      units_left_micro: o.units_open,
      expires_at: (o.credit_series as unknown as { expires_at: string }).expires_at,
      unit_usd_at_buy: Number(o.price_micro) / 1e6,
      tier: (o.credit_series as unknown as { tier: Tier }).tier,
    })),
  ];
  const tierUsd = (t: Tier) => (table.price.get(t) ?? 0) / 1e6;
  const lotValue = (l: (typeof open)[number]) => (Number(l.units_left_micro) / MICRO_UNITS) * tierUsd(l.tier);
  const units = open.reduce((t, l) => t + Number(l.units_left_micro), 0) / MICRO_UNITS;
  const value = open.reduce((t, l) => t + lotValue(l), 0); // what Fuel owes if every credit were used now
  const byTier = Object.fromEntries(
    (["max", "pro", "open", "lane"] as Tier[]).map((t) => {
      const ls = open.filter((l) => l.tier === t);
      const u = ls.reduce((s, l) => s + Number(l.units_left_micro), 0) / MICRO_UNITS;
      return [t, { credits: round(u, 6), price_usd: tierUsd(t), value_usd: round(u * tierUsd(t)) }];
    }),
  );
  const markup = markupBps() / 10_000;

  // Only credits that expire while the locked capacity still runs can be backed by it.
  const lockEnd = locked.until ? Date.parse(locked.until) : 0;
  const backable = open.filter((l) => Date.parse(l.expires_at) <= lockEnd).reduce((t, l) => t + lotValue(l), 0);
  const outlivesLock = value - backable;
  const backed = Math.min(backable, locked.value_usd);
  const unbacked = value - backed; // exposed to market prices: the reserve has to cover this
  const cost = unbacked / (1 + markup); // what buying that compute on the market costs Fuel
  const reserve = microToUsd(cfg.reserve_micro);
  const coverage = unbacked > 0 ? reserve / unbacked : null;
  const effective = cost > 0 ? reserve / cost : null;
  const soon = (days: number) => open.filter((l) => Date.parse(l.expires_at) - Date.now() < days * 86_400_000).reduce((t, l) => t + lotValue(l), 0);
  const paidPrincipal = open.reduce((t, l) => t + (Number(l.units_left_micro) / MICRO_UNITS) * Number(l.unit_usd_at_buy), 0);
  const utilisation = cfg.cap_usd > 0 ? value / cfg.cap_usd : 1;
  const premium_bps = Math.round(cfg.premium_max_bps * Math.min(1, utilisation));

  // Can Fuel sell more? (The database re-checks all of this atomically on each sale.)
  const capacityLeft = cfg.require_locked_capacity ? Math.max(0, locked.value_usd - value) : Infinity;
  const headroomUsd = Math.max(0, Math.min(cfg.cap_usd - value, capacityLeft));
  const selling: { open: boolean; reason: string } = !cfg.enabled
    ? { open: false, reason: CREDITS_OFF }
    : table.price.size === 0
      ? { open: false, reason: "No live model prices yet" }
      : cfg.require_locked_capacity && locked.value_usd <= 0
        ? { open: false, reason: "No locked capacity: add a Fuel-operated GPU with a locked cost and end date" }
        : headroomUsd <= 0
          ? { open: false, reason: cfg.require_locked_capacity && capacityLeft <= cfg.cap_usd - value ? "All promised capacity is sold" : "Total cap reached" }
          : effective !== null && effective < cfg.mint_min_coverage
            ? { open: false, reason: `Coverage of unbacked credits below ${Math.round(cfg.mint_min_coverage * 100)}%` }
            : locked.value_usd <= value && reserve <= 0
              ? { open: false, reason: "Reserve is empty: add to it before selling" }
              : { open: true, reason: "Selling" };

  // If prices rise by x, both what's owed and what the locked capacity is worth rise by x;
  // only the unbacked part costs Fuel more.
  const stress = [0.1, 0.2, 0.5, 1].map((up) => {
    const owe = value * (1 + up);
    const unb = Math.max(0, owe - Math.min(backable * (1 + up), locked.value_usd * (1 + up)));
    return { index_up_pct: up * 100, owe_usd: round(owe), backed_usd: round(owe - unb), cost_usd: round(unb / (1 + markup)), reserve_after_usd: round(reserve - unb / (1 + markup)) };
  });

  return {
    config: cfg,
    price,
    markup_pct: markupBps() / 100,
    outstanding: { credits: round(units, 6), holders: new Set(open.map((l) => l.wallet)).size, value_usd: round(value), cost_to_deliver_usd: round(cost), paid_principal_usd: round(paidPrincipal), by_tier: byTier },
    locked: {
      value_usd: round(locked.value_usd),
      until: locked.until,
      backed_usd: round(backed),
      unbacked_usd: round(unbacked),
      outlives_lock_usd: round(outlivesLock),
      backed_pct: value > 0 ? round((backed / value) * 100, 1) : null,
      items: locked.items.map((x) => ({ ...x, value_usd: round(x.value_usd) })),
    },
    reserve_usd: round(reserve),
    coverage: coverage === null ? null : round(coverage, 4),
    effective_coverage: effective === null ? null : round(effective, 4),
    surplus_usd: round(reserve - cost),
    expiring_usd: { "7d": round(soon(7)), "30d": round(soon(30)) },
    selling,
    redeem_limited: effective !== null && effective < cfg.redeem_limit_coverage,
    premium_bps,
    headroom_usd: round(headroomUsd),
    // How much Fuel must add to the reserve to reach the selling threshold at today's size.
    topup_to_sell_usd: round(Math.max(0, cfg.mint_min_coverage * cost - reserve)),
    stress,
  };
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Price a purchase of `credits` credits of a tier right now. */
export async function quote(credits: number, tier: Tier) {
  const [st, table] = await Promise.all([creditState(), tierTable()]);
  const tierMicro = table.price.get(tier) ?? 0;
  if (tierMicro <= 0) return { error: `No live prices for the ${tier} tier yet.` } as const;
  const unitUsd = tierMicro / 1e6;
  const unitsMicro = Math.round(credits * MICRO_UNITS);
  const principal = Math.ceil(unitsMicro * unitUsd); // micro-USD
  const fee = Math.ceil((principal * st.config.fee_bps) / 10_000);
  // Premium priced on how full the book is after this sale.
  const after = st.config.cap_usd > 0 ? Math.min(1, (st.outstanding.value_usd + principal / 1e6) / st.config.cap_usd) : 1;
  const premiumBps = Math.round(st.config.premium_max_bps * after);
  const premium = Math.ceil((principal * premiumBps) / 10_000);
  return { st, unitUsd, unitsMicro, principal, fee, premium, total: principal + fee + premium } as const;
}

export async function buyCredits(wallet: string, credits: number, tier: Tier) {
  const q = await quote(credits, tier);
  if ("error" in q) return { ok: false as const, code: "no_price", message: q.error! };
  if (!q.st.selling.open) return { ok: false as const, code: "not_selling", message: q.st.selling.reason };
  await syncTierPrices(); // caps and coverage in the database use the stored tier prices
  const { data, error } = await supabaseAdmin().rpc("fuel_credit_buy", {
    p_wallet: wallet,
    p_tier: tier,
    p_units_micro: q.unitsMicro,
    p_unit_usd: q.unitUsd,
    p_level: q.st.price?.level ?? 100,
    p_principal_micro: q.principal,
    p_fee_micro: q.fee,
    p_premium_micro: q.premium,
    p_markup_bps: markupBps(),
    p_locked_micro: Math.floor(q.st.locked.value_usd * 1e6),
  });
  if (error) return { ok: false as const, code: "server_error", message: "Could not buy credits." };
  const r = String(data);
  if (!r.startsWith("ok:")) return { ok: false as const, code: r, message: BUY_ERR[r] ?? r };
  const { data: lot } = await supabaseAdmin().from("credit_lots").select("series_id, credit_series(id, expires_at)").eq("id", r.slice(3)).maybeSingle();
  const series = (lot?.credit_series as unknown as { id: string; expires_at: string } | null) ?? null;
  const info = (await tiersOverview()).find((t) => t.id === tier);
  return {
    ok: true as const,
    lot_id: r.slice(3),
    tier,
    credits,
    unit_usd: q.unitUsd,
    paid_usd: microToUsd(q.total),
    breakdown_usd: { credits: microToUsd(q.principal), fee: microToUsd(q.fee), risk_premium: microToUsd(q.premium) },
    // What these credits buy, model by model (3:1 input:output mix).
    tokens: (info?.models ?? []).map((m) => ({ model: m.model, tokens: Math.floor(m.tokens_per_credit * credits) })),
    series: series?.id ?? null,
    expires_at: series?.expires_at ?? null,
  };
}

const BUY_ERR: Record<string, string> = {
  disabled: `${CREDITS_OFF}.`,
  no_tier: "That tier isn't on sale right now.",
  cap_reached: "The total credit cap is reached. Try a smaller amount or later.",
  wallet_cap_reached: "That would take you over the per-wallet credit cap.",
  coverage_low: "Credit sales are paused while the reserve is topped up.",
  capacity_cap: "All the compute Fuel has locked in for credits is sold. Try a smaller amount or later.",
  insufficient_balance: "Not enough balance (credits are paid from your Fuel balance).",
  bad_amount: "Amount must be above zero.",
};

const CONVERT_ERR: Record<string, string> = {
  bad_amount: "Convert at least 0.01 credits.",
  no_series: "No such series.",
  same_tier: "That series is already in this tier.",
  no_tier: "No such tier.",
  not_cheaper: "Credits can only be converted into a cheaper tier (buy a dearer tier's credits on the market).",
  series_expiring: "This series expires within the hour.",
  not_enough_credits: "You don't hold that many credits in this series.",
};

/** Converts credits of a series into a cheaper tier's credits of the same month, at the price ratio minus a fee. */
export async function tradeDown(wallet: string, series: string, toTier: Tier, credits: number) {
  const [cfg, table, { data: s }] = await Promise.all([creditConfig(), tierTable(), supabaseAdmin().from("credit_series").select("tier").eq("id", series).maybeSingle()]);
  if (!cfg.enabled) return { ok: false as const, code: "disabled", message: `${CREDITS_OFF}.` };
  if (!s) return { ok: false as const, code: "no_series", message: CONVERT_ERR.no_series };
  const from = table.price.get(s.tier as Tier) ?? 0;
  const to = table.price.get(toTier) ?? 0;
  const { data, error } = await supabaseAdmin().rpc("fuel_credit_trade_down", {
    p_wallet: wallet,
    p_series: series,
    p_to_tier: toTier,
    p_units: Math.round(credits * MICRO_UNITS),
    p_from_price: from,
    p_to_price: to,
    p_fee_bps: cfg.trade_down_fee_bps,
  });
  if (error) return { ok: false as const, code: "server_error", message: "Could not convert credits." };
  const r = String(data);
  if (!r.startsWith("ok:")) return { ok: false as const, code: r, message: CONVERT_ERR[r] ?? r };
  const [, toSeries, out] = r.split(":");
  return { ok: true as const, from_series: series, to_series: toSeries, credits_in: credits, credits_out: Number(out) / MICRO_UNITS, rate: to > 0 ? from / to : null, fee_pct: cfg.trade_down_fee_bps / 100 };
}

/** Called by the cron: lots past their expiry are used automatically for their holders. */
export async function expireCredits() {
  await syncTierPrices(); // expiry values each lot at its tier's current price
  const price = (await unitPrice()) ?? { level: 100 };
  // Open orders in a series that's about to expire are cancelled first (credits and money go back).
  const { data: closed } = await supabaseAdmin().rpc("fuel_credit_close_series", { p_level: price.level });
  const { data, error } = await supabaseAdmin().rpc("fuel_credit_expire", { p_unit_usd: 0, p_level: price.level });
  return error ? { expired: 0, orders_closed: Number(closed ?? 0), error: error.message } : { expired: Number(data), orders_closed: Number(closed ?? 0) };
}

export async function myCredits(wallet: string) {
  const [table, { data }] = await Promise.all([
    tierTable(),
    supabaseAdmin()
      .from("credit_lots")
      .select("id, units_micro, units_left_micro, unit_usd_at_buy, level_at_buy, paid_micro, created_at, expires_at, status, series_id, credit_series(tier)")
      .eq("wallet", wallet)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  const lots = (data ?? []).map((l) => ({
    id: l.id,
    tier: ((l.credit_series as unknown as { tier: Tier } | null)?.tier ?? "open") as Tier,
    credits: Number(l.units_micro) / MICRO_UNITS,
    credits_left: Number(l.units_left_micro) / MICRO_UNITS,
    bought_at_usd: Number(l.unit_usd_at_buy),
    paid_usd: microToUsd(l.paid_micro),
    created_at: l.created_at,
    expires_at: l.expires_at,
    status: l.status,
    series: l.series_id as string | null,
  }));
  const open = lots.filter((l) => l.status === "open");
  const left = open.reduce((t, l) => t + l.credits_left, 0);
  const value = open.reduce((t, l) => t + l.credits_left * ((table.price.get(l.tier) ?? 0) / 1e6), 0);
  // Holdings per series (what can be sold), soonest expiry first.
  const bySeries = new Map<string, { series: string; tier: Tier; credits: number; expires_at: string }>();
  for (const l of open) {
    const k = l.series ?? "unknown";
    const cur = bySeries.get(k) ?? { series: k, tier: l.tier, credits: 0, expires_at: l.expires_at };
    cur.credits = round(cur.credits + l.credits_left, 6);
    bySeries.set(k, cur);
  }
  const series = [...bySeries.values()].sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  const tiers = Object.fromEntries(
    (["max", "pro", "open", "lane"] as Tier[]).map((t) => [t, round(open.filter((l) => l.tier === t).reduce((s, l) => s + l.credits_left, 0), 6)]),
  );
  return { credits: round(left, 6), value_usd: round(value, 6), tiers, series, lots };
}
