import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { microToUsd } from "@/lib/money";
import { marketRates } from "@/lib/market";
import { creditConfig } from "@/lib/credits";

// Capacity contracts: sellers sell compute forward (see migration 0013).

export const TERMS = [30, 60, 90] as const;
const typical = (inP: number, outP: number) => (inP * 3 + outP) / 4; // USD per 1M tokens, 3:1 job

export type Contract = {
  id: string;
  seller_id: string;
  wallet: string;
  model: string;
  ceiling_in: number;
  ceiling_out: number;
  volume_mtok: number;
  term_days: number;
  premium_pct: number;
  notional_usd: number;
  bond_usd: number;
  premium_usd: number;
  status: string;
  used_mtok: number;
  failing_since: string | null;
  note: string | null;
  created_at: string;
  starts_at: string | null;
  ends_at: string | null;
  settled_at: string | null;
};

function shape(r: Record<string, unknown>): Contract {
  return {
    id: r.id as string,
    seller_id: r.seller_id as string,
    wallet: r.wallet as string,
    model: r.model as string,
    ceiling_in: Number(r.ceiling_in),
    ceiling_out: Number(r.ceiling_out),
    volume_mtok: Number(r.volume_mtok),
    term_days: Number(r.term_days),
    premium_pct: Number(r.premium_pct),
    notional_usd: microToUsd(r.notional_micro as number),
    bond_usd: microToUsd(r.bond_micro as number),
    premium_usd: microToUsd(r.premium_micro as number),
    status: r.status as string,
    used_mtok: Number(r.used_mtok),
    failing_since: (r.failing_since as string) ?? null,
    note: (r.note as string) ?? null,
    created_at: r.created_at as string,
    starts_at: (r.starts_at as string) ?? null,
    ends_at: (r.ends_at as string) ?? null,
    settled_at: (r.settled_at as string) ?? null,
  };
}

/** Terms a seller can offer right now. */
export async function forwardTerms() {
  const c = await creditConfig();
  return { terms_days: TERMS, bond_pct: c.forward_bond_pct * 100, max_premium_pct: c.forward_max_premium_pct, breach_hours: c.forward_breach_hours };
}

type OfferIn = { model?: unknown; ceiling_in?: unknown; ceiling_out?: unknown; volume_mtok?: unknown; term_days?: unknown; premium_pct?: unknown };

export async function offerContract(wallet: string, b: OfferIn) {
  const db = supabaseAdmin();
  const cfg = await creditConfig();
  const fail = (code: string, message: string) => ({ ok: false as const, code, message });
  const { data: seller } = await db.from("sellers").select("id, status, operated_by_fuel").eq("wallet", wallet).maybeSingle();
  if (!seller) return fail("not_a_seller", "List your endpoint first; contracts are for approved sellers.");
  if (seller.operated_by_fuel) return fail("fuel_operated", "Fuel-operated capacity doesn't use contracts: its locked cost is recorded on the admin page instead.");
  if (seller.status !== "approved") return fail("not_approved", "Your listing must be live (a passing model) to offer contracts.");
  const model = typeof b.model === "string" ? b.model : "";
  const { data: m } = await db.from("seller_models").select("model, kind, input_per_mtok, output_per_mtok, probe_ok").eq("seller_id", seller.id).eq("model", model).maybeSingle();
  if (!m) return fail("unknown_model", `'${model}' isn't one of your listed models.`);
  if (m.kind !== "chat") return fail("chat_only", "Contracts are for chat models (the index tracks chat compute).");
  if (!m.probe_ok) return fail("model_failing", "That model isn't passing its test right now.");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const ceilIn = num(b.ceiling_in);
  const ceilOut = b.ceiling_out === undefined ? Number(m.output_per_mtok) : num(b.ceiling_out);
  const volume = num(b.volume_mtok);
  const term = num(b.term_days);
  const premium = num(b.premium_pct);
  if (!(ceilIn >= 0) || !(ceilOut >= 0) || ceilIn > 1000 || ceilOut > 1000) return fail("bad_price", "Ceiling prices must be 0–1000 USD per 1M tokens.");
  if (ceilIn < Number(m.input_per_mtok) || ceilOut < Number(m.output_per_mtok)) return fail("ceiling_below_listing", "The ceiling can't be below your current price (lower your listing first).");
  if (!(volume >= 1 && volume <= 100_000)) return fail("bad_volume", "Volume must be 1–100,000 million tokens.");
  if (!TERMS.includes(term as (typeof TERMS)[number])) return fail("bad_term", "Term must be 30, 60 or 90 days.");
  if (!(premium >= 0 && premium <= cfg.forward_max_premium_pct)) return fail("bad_premium", `Premium must be 0–${cfg.forward_max_premium_pct}% of the contract's value.`);
  const notional = Math.round(volume * typical(ceilIn, ceilOut) * 1e6); // micro-USD
  if (notional < 1e6) return fail("too_small", "The contract must be worth at least $1 (volume × ceiling price).");
  const bond = Math.ceil(notional * cfg.forward_bond_pct);
  const premiumMicro = Math.floor((notional * premium) / 100);
  const { data, error } = await db.rpc("fuel_forward_offer", {
    p_wallet: wallet,
    p_seller: seller.id,
    p_model: model,
    p_ceiling_in: ceilIn,
    p_ceiling_out: ceilOut,
    p_volume_mtok: volume,
    p_term_days: term,
    p_premium_pct: premium,
    p_notional_micro: notional,
    p_bond_micro: bond,
    p_premium_micro: premiumMicro,
  });
  if (error) return fail("server_error", "Could not save the offer.");
  const r = String(data);
  if (r === "already_committed") return fail(r, "You already have an open or active contract for that model.");
  if (r === "insufficient_balance") return fail(r, `The bond is $${microToUsd(bond).toFixed(2)} (${cfg.forward_bond_pct * 100}% of $${microToUsd(notional).toFixed(2)}); top up your Fuel balance first.`);
  if (!r.startsWith("ok:")) return fail(r, r);
  return { ok: true as const, id: r.slice(3), notional_usd: microToUsd(notional), bond_usd: microToUsd(bond), premium_usd: microToUsd(premiumMicro) };
}

export async function contractsFor(wallet: string) {
  const { data } = await supabaseAdmin().from("capacity_contracts").select("*").eq("wallet", wallet).order("created_at", { ascending: false }).limit(50);
  return (data ?? []).map(shape);
}

export async function allContracts() {
  const { data } = await supabaseAdmin().from("capacity_contracts").select("*, sellers(name)").order("created_at", { ascending: false }).limit(200);
  return (data ?? []).map((r) => ({ ...shape(r), seller_name: (r.sellers as { name?: string } | null)?.name ?? null }));
}

/** The ceiling an active/offered contract puts on a seller's listing, per model. */
export async function ceilingsFor(sellerId: string) {
  const { data } = await supabaseAdmin().from("capacity_contracts").select("model, ceiling_in, ceiling_out, ends_at, status").eq("seller_id", sellerId).in("status", ["offered", "active"]);
  return new Map((data ?? []).map((c) => [c.model as string, { in: Number(c.ceiling_in), out: Number(c.ceiling_out), until: (c.ends_at as string) ?? null }]));
}

export async function acceptContract(id: string) {
  const db = supabaseAdmin();
  const { data: c } = await db.from("capacity_contracts").select("status, term_days").eq("id", id).maybeSingle();
  if (!c) return "not_found";
  if (c.status !== "offered") return "wrong_state";
  const now = new Date();
  const ends = new Date(now.getTime() + c.term_days * 86_400_000);
  const { error } = await db.from("capacity_contracts").update({ status: "active", starts_at: now.toISOString(), ends_at: ends.toISOString() }).eq("id", id).eq("status", "offered");
  return error ? "server_error" : "ok";
}

export async function closeContract(id: string, outcome: "withdrawn" | "rejected" | "completed" | "breached", note?: string) {
  const { data, error } = await supabaseAdmin().rpc("fuel_forward_close", { p_id: id, p_outcome: outcome, p_note: note ?? null });
  return error ? "server_error" : String(data);
}

/**
 * Cron: update usage, watch health, and close contracts that are done.
 *  - usage: tokens the seller served for the model since the start
 *  - fulfilled (volume reached) or term over → completed (bond back + premium)
 *  - model failing or seller not approved for longer than breach_hours → breached (bond kept)
 */
export async function forwardsTick() {
  const db = supabaseAdmin();
  const cfg = await creditConfig();
  const { data: active } = await db.from("capacity_contracts").select("*").eq("status", "active");
  const out = { checked: 0, completed: 0, breached: 0 };
  for (const c of active ?? []) {
    out.checked++;
    const { data: jobs } = await db
      .from("jobs")
      .select("input_tokens, output_tokens")
      .eq("provider", `seller:${c.seller_id}`)
      .eq("model", c.model)
      .eq("status", "succeeded")
      .gte("created_at", c.starts_at)
      .limit(100_000);
    const used = (jobs ?? []).reduce((t, j) => t + (Number(j.input_tokens ?? 0) + Number(j.output_tokens ?? 0)), 0) / 1e6;

    const [{ data: s }, { data: m }] = await Promise.all([
      db.from("sellers").select("status").eq("id", c.seller_id).maybeSingle(),
      db.from("seller_models").select("probe_ok, input_per_mtok, output_per_mtok").eq("seller_id", c.seller_id).eq("model", c.model).maybeSingle(),
    ]);
    const healthy = s?.status === "approved" && !!m?.probe_ok && Number(m.input_per_mtok) <= Number(c.ceiling_in) && Number(m.output_per_mtok) <= Number(c.ceiling_out);
    const failingSince = healthy ? null : (c.failing_since ?? new Date().toISOString());
    await db.from("capacity_contracts").update({ used_mtok: Math.round(used * 1e6) / 1e6, failing_since: failingSince }).eq("id", c.id);

    if (failingSince && Date.now() - Date.parse(failingSince) > cfg.forward_breach_hours * 3_600_000) {
      const why = !s || s.status !== "approved" ? "listing not live" : !m ? "model removed" : !m.probe_ok ? "model failing its test" : "price above the ceiling";
      if ((await closeContract(c.id, "breached", `Breached: ${why} for over ${cfg.forward_breach_hours} h.`)) === "ok") out.breached++;
    } else if (used >= Number(c.volume_mtok)) {
      if ((await closeContract(c.id, "completed", "Volume delivered in full.")) === "ok") out.completed++;
    } else if (c.ends_at && Date.now() >= Date.parse(c.ends_at)) {
      if ((await closeContract(c.id, "completed", "Term completed.")) === "ok") out.completed++;
    }
  }
  return out;
}

/**
 * How much of Fuel's compute cost is capped by active contracts, and what that is worth now.
 * protected_usd: remaining volume × ceiling (cost Fuel has locked in).
 * in_the_money_usd: how much cheaper than today's market that locked capacity is (0 if not).
 * saved_at(x): extra cost avoided if market prices for those models rose by x.
 */
export async function hedgeSummary() {
  const db = supabaseAdmin();
  const [{ data: active }, rates] = await Promise.all([db.from("capacity_contracts").select("*").eq("status", "active"), marketRates()]);
  const spot = new Map(rates.map((r) => [r.model, typical(r.low.in, r.low.out)]));
  const rows = (active ?? []).map((c) => {
    const left = Math.max(0, Number(c.volume_mtok) - Number(c.used_mtok));
    const ceil = typical(Number(c.ceiling_in), Number(c.ceiling_out));
    const market = spot.get(c.model) ?? ceil;
    return { model: c.model as string, left, ceil, market };
  });
  const protectedUsd = rows.reduce((t, r) => t + r.left * r.ceil, 0);
  const itm = rows.reduce((t, r) => t + r.left * Math.max(0, r.market - r.ceil), 0);
  const savedAt = (x: number) => rows.reduce((t, r) => t + r.left * Math.max(0, r.market * (1 + x) - r.ceil), 0);
  const { count: offered } = await db.from("capacity_contracts").select("id", { count: "exact", head: true }).eq("status", "offered");
  // Fuel-operated GPUs with a locked cost (e.g. a prepaid rental) still running.
  const { data: houseRows } = await db
    .from("sellers")
    .select("name, locked_cost_hr, locked_tps, locked_until, status")
    .eq("operated_by_fuel", true)
    .gt("locked_until", new Date().toISOString());
  const house = (houseRows ?? [])
    .filter((h) => h.locked_cost_hr !== null && h.locked_tps)
    .map((h) => {
      const hours = Math.max(0, (Date.parse(h.locked_until as string) - Date.now()) / 3_600_000);
      const mtokHr = (Number(h.locked_tps) * 3600) / 1e6;
      return {
        name: h.name as string,
        live: h.status === "approved",
        cost_hr: Number(h.locked_cost_hr),
        until: h.locked_until as string,
        capacity_left_mtok: Math.round(mtokHr * hours),
        cost_per_mtok_full_load: Math.round((Number(h.locked_cost_hr) / mtokHr) * 10_000) / 10_000,
      };
    });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    active: rows.length,
    offered: offered ?? 0,
    volume_left_mtok: Math.round(rows.reduce((t, r) => t + r.left, 0) * 1000) / 1000,
    protected_usd: r2(protectedUsd),
    in_the_money_usd: r2(itm),
    saved_at: { "10": r2(savedAt(0.1)), "20": r2(savedAt(0.2)), "50": r2(savedAt(0.5)), "100": r2(savedAt(1)) },
    fuel_operated: house,
  };
}
