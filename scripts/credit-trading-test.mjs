// Credit trading (order book per series), end to end, against a dev server:
//   node --env-file=.env.local scripts/credit-trading-test.mjs http://localhost:3000
// Two wallets trade credits; checks matching, prices, fees, escrow, cancels, self-trade,
// expiry close-out, and that credits and money are conserved. Restores config exactly.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (body) =>
  fetch(BASE + "/v1/admin/credits", { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-admin-token": process.env.FUEL_ADMIN_TOKEN }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
async function newWallet(fund) {
  const sk = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  await db.rpc("fuel_credit_deposit", { p_signature: `trade-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: fund * 1e6, p_usd_price: null, p_credit: fund * 1e6, p_slot: 0 });
  return { wallet, key };
}
const bal = async (w) => Number((await db.from("accounts").select("balance_micro").eq("wallet", w).single()).data.balance_micro);
const held = async (w) => {
  const { data: lots } = await db.from("credit_lots").select("units_left_micro").eq("wallet", w).eq("status", "open");
  const { data: sells } = await db.from("credit_orders").select("units_open").eq("wallet", w).eq("status", "open").eq("side", "sell");
  return { lots: (lots ?? []).reduce((t, l) => t + Number(l.units_left_micro), 0) / 1e6, selling: (sells ?? []).reduce((t, o) => t + Number(o.units_open), 0) / 1e6 };
};
const order = (key, body) => req("/v1/credits/orders", { key, method: "POST", body });
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

const { data: saved } = await db.from("credit_config").select("*").eq("id", 1).single();
const startedAt = new Date().toISOString();
let A, B, series, seriesExpiry;
try {
  A = await newWallet(20);
  B = await newWallet(10);
  await admin({ action: "config", enabled: true, require_locked_capacity: false, trading_enabled: false, trade_fee_bps: 50, cap_usd: 2500, wallet_cap_usd: 250, mint_min_coverage: 1.25 });
  await admin({ action: "reserve", usd: 20, note: "trade-test" });
  const buy = await (await req("/v1/credits/buy", { key: A.key, method: "POST", body: { tier: "open", credits: 10 } })).json();
  series = buy.series;
  seriesExpiry = buy.expires_at;
  check("bought credits land in this month's series", /^\d{4}-\d{2}-open$/.test(series ?? "") && Date.parse(seriesExpiry) > Date.now(), `${series} → ${seriesExpiry}`);

  let r = await order(A.key, { series, side: "sell", price_usd: 0.6, credits: 4 });
  check("trading off: orders refused", r.status === 409 && (await r.json()).error.code === "trading_off");
  await admin({ action: "config", trading_enabled: true });

  const a0 = await bal(A.wallet), b0 = await bal(B.wallet);
  r = await order(A.key, { series, side: "sell", price_usd: 0.6, credits: 4 });
  const sellA = await r.json();
  let hA = await held(A.wallet);
  check("sell order rests and holds the credits", r.status === 201 && sellA.status === "open" && hA.lots === 6 && hA.selling === 4, JSON.stringify(hA));
  let st = await admin();
  check("credits in sell orders still count as owed by Fuel", st.outstanding.credits === 10, String(st.outstanding.credits));

  r = await order(B.key, { series, side: "buy", price_usd: 0.55, credits: 3 });
  const bidB = await r.json();
  check("bid below the ask rests (no trade)", r.status === 201 && bidB.filled_credits === 0 && bidB.status === "open");
  check("bid holds price × credits + 0.5% fee", b0 - (await bal(B.wallet)) === 1658250, String(b0 - (await bal(B.wallet))));

  const bBefore = await bal(B.wallet);
  r = await order(B.key, { series, side: "buy", price_usd: 0.65, credits: 2 });
  const take = await r.json();
  check("crossing bid trades at once, at the resting ask's price", r.status === 201 && take.filled_credits === 2 && take.status === "filled");
  check("buyer pays $0.60 × 2 + fee (overpay refunded)", bBefore - (await bal(B.wallet)) === 1206000, String(bBefore - (await bal(B.wallet))));
  check("seller gets $0.60 × 2 − fee", (await bal(A.wallet)) - a0 === 1194000, String((await bal(A.wallet)) - a0));
  let hB = await held(B.wallet);
  check("buyer now holds 2 credits of the series", hB.lots === 2);

  const a1 = await bal(A.wallet);
  r = await order(A.key, { series, side: "sell", price_usd: 0.5, credits: 1 });
  const hit = await r.json();
  check("sell into the best bid trades at the bid's price ($0.55)", hit.filled_credits === 1 && (await bal(A.wallet)) - a1 === 547250, String((await bal(A.wallet)) - a1));
  hB = await held(B.wallet);
  check("bidder receives the credit", hB.lots === 3);

  r = await order(A.key, { series, side: "buy", price_usd: 0.6, credits: 1 });
  const self = await r.json();
  check("never trades against your own order", self.filled_credits === 0);
  await req(`/v1/credits/orders/${self.order_id}`, { key: A.key, method: "DELETE" });

  const b2 = await bal(B.wallet);
  r = await req(`/v1/credits/orders/${bidB.order_id}`, { key: B.key, method: "DELETE" });
  check("cancel a bid: the rest of the held money comes back", r.status === 200 && (await bal(B.wallet)) - b2 === 1105500, String((await bal(B.wallet)) - b2));
  r = await req(`/v1/credits/orders/${sellA.order_id}`, { key: A.key, method: "DELETE" });
  hA = await held(A.wallet);
  check("cancel a sell: unsold credits come back", r.status === 200 && hA.lots === 7 && hA.selling === 0, JSON.stringify(hA));
  r = await req(`/v1/credits/orders/${sellA.order_id}`, { key: B.key, method: "DELETE" });
  check("can't cancel someone else's order", r.status === 404);

  r = await order(A.key, { series, side: "sell", price_usd: 0.6, credits: 100 });
  check("can't sell credits you don't hold", r.status === 409 && (await r.json()).error.code === "not_enough_credits");

  hA = await held(A.wallet);
  hB = await held(B.wallet);
  check("credits conserved (10 in total)", hA.lots + hA.selling + hB.lots + hB.selling === 10);
  const fees = (await db.from("credit_trades").select("buyer_fee, seller_fee").eq("series_id", series).gte("at", startedAt)).data.reduce((t, x) => t + Number(x.buyer_fee) + Number(x.seller_fee), 0);
  check("money conserved (only fees leave)", near((await bal(A.wallet)) - a0 + (await bal(B.wallet)) - b0, -fees), `fees ${fees}`);

  const ov = await (await req("/v1/credits/market")).json();
  const s = ov.series.find((x) => x.series === series);
  check("market shows last price, premium to value and 24h volume", s && s.last_usd === 0.55 && s.premium_pct !== null && s.volume_24h_credits === 3, JSON.stringify(s));
  const book = await (await req(`/v1/credits/market/${series}`)).json();
  check("book shows recent trades", book.trades.length >= 2);

  // Expiry close-out: open orders are cancelled before the series expires
  r = await order(A.key, { series, side: "sell", price_usd: 0.9, credits: 1 });
  const late = await r.json();
  await db.from("credit_series").update({ expires_at: new Date(Date.now() + 30 * 60000).toISOString() }).eq("id", series);
  r = await order(B.key, { series, side: "buy", price_usd: 0.5, credits: 1 });
  check("no new orders in the last hour before expiry", r.status === 409 && (await r.json()).error.code === "series_expiring");
  const { data: closed } = await db.rpc("fuel_credit_close_series", { p_level: 100 });
  const { data: lo } = await db.from("credit_orders").select("status").eq("id", late.order_id).single();
  check("open orders closed out before expiry, credits returned", closed >= 1 && lo.status === "cancelled" && (await held(A.wallet)).selling === 0);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  if (series && seriesExpiry) await db.from("credit_series").update({ expires_at: seriesExpiry }).eq("id", series);
  const cfg = { ...saved };
  delete cfg.id;
  await db.from("credit_config").update(cfg).eq("id", 1);
  await db.from("credit_events").delete().gte("at", startedAt);
  for (const w of [A?.wallet, B?.wallet].filter(Boolean)) {
    await db.from("credit_trades").delete().or(`buyer.eq.${w},seller.eq.${w}`);
    await db.from("credit_orders").delete().eq("wallet", w);
    await db.from("credit_lots").delete().eq("wallet", w);
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", w);
    await db.from("accounts").delete().eq("wallet", w);
  }
  const { data: c } = await db.from("credit_config").select("enabled, trading_enabled, reserve_micro").eq("id", 1).single();
  console.log(`config restored: ${JSON.stringify(c)}`);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
