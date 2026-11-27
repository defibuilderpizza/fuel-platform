import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { microToUsd } from "@/lib/money";
import { creditConfig, unitPrice, MICRO_UNITS } from "@/lib/credits";
import { tierTable, type Tier } from "@/lib/credit-tiers";

// Credit trading inside Fuel: an order book per series, i.e. per month per tier (migrations 0017,
// 0024). Prices are USD per credit. A credit's "value" is what Fuel sells it for today (its tier's
// price, from live provider prices); the traded price is what the market thinks it's worth.

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function marketOverview() {
  const db = supabaseAdmin();
  const [cfg, table] = await Promise.all([creditConfig(), tierTable()]);
  const { data: series } = await db.from("credit_series").select("*").gt("expires_at", new Date().toISOString()).order("expires_at");
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const out = [];
  for (const s of series ?? []) {
    const [{ data: bids }, { data: asks }, { data: last }, { data: day }] = await Promise.all([
      db.from("credit_orders").select("price_micro").eq("series_id", s.id).eq("status", "open").eq("side", "buy").order("price_micro", { ascending: false }).limit(1),
      db.from("credit_orders").select("price_micro").eq("series_id", s.id).eq("status", "open").eq("side", "sell").order("price_micro", { ascending: true }).limit(1),
      db.from("credit_trades").select("price_micro, at").eq("series_id", s.id).order("at", { ascending: false }).limit(1),
      db.from("credit_trades").select("units_micro, price_micro").eq("series_id", s.id).gte("at", since),
    ]);
    const lastPx = last?.[0] ? microToUsd(last[0].price_micro) : null;
    const tierMicro = table.price.get(s.tier as Tier) ?? 0;
    const value = tierMicro > 0 ? tierMicro / 1e6 : null;
    out.push({
      series: s.id as string,
      tier: s.tier as Tier,
      expires_at: s.expires_at as string,
      days_left: Math.max(0, Math.round((Date.parse(s.expires_at) - Date.now()) / 86_400_000)),
      value_usd: value,
      best_bid_usd: bids?.[0] ? microToUsd(bids[0].price_micro) : null,
      best_ask_usd: asks?.[0] ? microToUsd(asks[0].price_micro) : null,
      last_usd: lastPx,
      last_at: last?.[0]?.at ?? null,
      // Above value: the market expects compute to get dearer before expiry (or Fuel's promised
      // capacity is sold out). Below: cheaper, or holders want cash now.
      premium_pct: lastPx !== null && value ? Math.round((lastPx / value - 1) * 10_000) / 100 : null,
      volume_24h_credits: r6((day ?? []).reduce((t, x) => t + Number(x.units_micro), 0) / MICRO_UNITS),
      volume_24h_usd: r6((day ?? []).reduce((t, x) => t + (Number(x.units_micro) * Number(x.price_micro)) / 1e12, 0)),
    });
  }
  return { trading: cfg.enabled && cfg.trading_enabled, fee_pct: cfg.trade_fee_bps / 100, series: out };
}

/** Order book (price levels) and recent trades for one series. */
export async function seriesBook(series: string) {
  const db = supabaseAdmin();
  const [{ data: orders }, { data: trades }, { data: s }] = await Promise.all([
    db.from("credit_orders").select("side, price_micro, units_open").eq("series_id", series).eq("status", "open").limit(2000),
    db.from("credit_trades").select("at, price_micro, units_micro").eq("series_id", series).order("at", { ascending: false }).limit(50),
    db.from("credit_series").select("*").eq("id", series).maybeSingle(),
  ]);
  if (!s) return null;
  const levels = (side: "buy" | "sell") => {
    const m = new Map<number, number>();
    for (const o of (orders ?? []).filter((x) => x.side === side)) m.set(Number(o.price_micro), (m.get(Number(o.price_micro)) ?? 0) + Number(o.units_open));
    return [...m.entries()]
      .sort((a, b) => (side === "buy" ? b[0] - a[0] : a[0] - b[0]))
      .slice(0, 15)
      .map(([px, u]) => ({ price_usd: microToUsd(px), credits: r6(u / MICRO_UNITS) }));
  };
  return {
    series: s.id as string,
    tier: s.tier as Tier,
    expires_at: s.expires_at as string,
    bids: levels("buy"),
    asks: levels("sell"),
    trades: (trades ?? []).map((t) => ({ at: t.at, price_usd: microToUsd(t.price_micro), credits: r6(Number(t.units_micro) / MICRO_UNITS) })),
  };
}

const PLACE_ERR: Record<string, string> = {
  trading_off: "Credit trading isn't open yet: it opens with credits after the Fuel token launch.",
  no_series: "No such series.",
  series_expiring: "This series expires within the hour; trading in it has closed.",
  too_many_orders: "You have 20 open orders; cancel some first.",
  not_enough_credits: "You don't hold that many credits in this series.",
  insufficient_balance: "Not enough balance for this bid (price × amount + fee is held until it fills or you cancel).",
  bad_amount: "Price must be above zero and the amount at least 0.01 credits.",
  bad_side: "'side' must be buy or sell.",
  no_account: "No Fuel account for this wallet yet.",
};

export async function placeOrder(wallet: string, series: string, side: string, priceUsd: number, credits: number) {
  const price = await unitPrice();
  const { data, error } = await supabaseAdmin().rpc("fuel_credit_place", {
    p_wallet: wallet,
    p_series: series,
    p_side: side,
    p_price_micro: Math.round(priceUsd * 1e6),
    p_units_micro: Math.round(credits * MICRO_UNITS),
    p_level: price?.level ?? 100,
  });
  if (error) return { ok: false as const, code: "server_error", message: "Could not place the order." };
  const r = String(data);
  if (!r.startsWith("ok:")) return { ok: false as const, code: r, message: PLACE_ERR[r] ?? r };
  const [, id, filled] = r.split(":");
  const { data: o } = await supabaseAdmin().from("credit_orders").select("status, units_open").eq("id", id).single();
  return { ok: true as const, order_id: id, filled_credits: r6(Number(filled) / MICRO_UNITS), open_credits: r6(Number(o?.units_open ?? 0) / MICRO_UNITS), status: o?.status ?? "open" };
}

export async function cancelOrder(wallet: string, id: string) {
  const price = await unitPrice();
  const { data, error } = await supabaseAdmin().rpc("fuel_credit_cancel", { p_order: id, p_wallet: wallet, p_level: price?.level ?? 100 });
  if (error) return "server_error";
  return String(data);
}

export async function myOrders(wallet: string) {
  const db = supabaseAdmin();
  const [{ data: orders }, { data: trades }] = await Promise.all([
    db.from("credit_orders").select("id, series_id, side, price_micro, units_micro, units_open, status, created_at").eq("wallet", wallet).order("created_at", { ascending: false }).limit(50),
    db.from("credit_trades").select("at, series_id, price_micro, units_micro, buyer, seller, buyer_fee, seller_fee").or(`buyer.eq.${wallet},seller.eq.${wallet}`).order("at", { ascending: false }).limit(50),
  ]);
  return {
    orders: (orders ?? []).map((o) => ({
      id: o.id,
      series: o.series_id,
      side: o.side,
      price_usd: microToUsd(o.price_micro),
      credits: r6(Number(o.units_micro) / MICRO_UNITS),
      open_credits: r6(Number(o.units_open) / MICRO_UNITS),
      status: o.status,
      created_at: o.created_at,
    })),
    trades: (trades ?? []).map((t) => ({
      at: t.at,
      series: t.series_id,
      side: t.buyer === wallet ? "bought" : "sold",
      price_usd: microToUsd(t.price_micro),
      credits: r6(Number(t.units_micro) / MICRO_UNITS),
      fee_usd: microToUsd(t.buyer === wallet ? t.buyer_fee : t.seller_fee),
    })),
  };
}

/** Admin: trading activity. */
export async function tradingStats() {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: trades }, { count: openOrders }] = await Promise.all([
    db.from("credit_trades").select("units_micro, price_micro, buyer_fee, seller_fee").gte("at", since).limit(50_000),
    db.from("credit_orders").select("id", { count: "exact", head: true }).eq("status", "open"),
  ]);
  const t = trades ?? [];
  return {
    trades_30d: t.length,
    volume_30d_usd: r6(t.reduce((s, x) => s + (Number(x.units_micro) * Number(x.price_micro)) / 1e12, 0)),
    fees_30d_usd: r6(t.reduce((s, x) => s + Number(x.buyer_fee) + Number(x.seller_fee), 0) / 1e6),
    open_orders: openOrders ?? 0,
  };
}
