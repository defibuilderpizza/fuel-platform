// Compute credits, end to end, against a dev server:
//   node --env-file=.env.local scripts/credits-test.mjs http://localhost:3000
// Turns credits on briefly with test settings, then restores the saved config and reserve
// exactly and deletes everything it created.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ADMIN = process.env.FUEL_ADMIN_TOKEN;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (body) =>
  fetch(BASE + "/v1/admin/credits", { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-admin-token": ADMIN }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const balance = async (w) => Number((await db.from("accounts").select("balance_micro").eq("wallet", w).single()).data.balance_micro);
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

const { data: saved } = await db.from("credit_config").select("*").eq("id", 1).single();
const startedAt = new Date().toISOString();
let wallet;
try {
  const sk = ed25519.utils.randomSecretKey();
  wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  await db.rpc("fuel_credit_deposit", { p_signature: `credits-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: 20e6, p_usd_price: null, p_credit: 20e6, p_slot: 0 });

  // Off by default
  await admin({ action: "config", enabled: false });
  let pub = await (await req("/v1/credits")).json();
  check("credits off: not selling", pub.selling === false && /token launch/.test(pub.status), pub.status);
  check("each tier has a live price", pub.tiers.open.price_usd > 0 && pub.tiers.pro.price_usd > pub.tiers.open.price_usd, JSON.stringify(pub.tiers));
  let r = await req("/v1/credits/buy", { key, method: "POST", body: { tier: "open", credits: 10 } });
  check("buying refused while off", r.status === 409);

  // On, but no reserve yet
  await admin({ action: "config", enabled: true, require_locked_capacity: false, cap_usd: 2500, wallet_cap_usd: 250, mint_min_coverage: 1.25, redeem_limit_coverage: 1.1, redeem_daily_usd: 50, fee_bps: 100, premium_max_bps: 300 });
  await db.from("credit_config").update({ reserve_micro: 0 }).eq("id", 1);
  pub = await (await req("/v1/credits")).json();
  check("empty reserve: not selling", pub.selling === false && /Reserve is empty/.test(pub.status), pub.status);

  // Seed the reserve, buy
  await admin({ action: "reserve", usd: 5, note: "credits-test" });
  pub = await (await req("/v1/credits")).json();
  check("reserve seeded: selling", pub.selling === true, pub.status);
  const before = await balance(wallet);
  r = await req("/v1/credits/buy", { key, method: "POST", body: { tier: "open", credits: 10 } });
  const buy = await r.json();
  const unit = pub.tiers.open.price_usd;
  const principal = Math.ceil(10e6 * unit);
  check("bought 10 credits", r.status === 201 && buy.credits === 10, JSON.stringify(buy.breakdown_usd ?? buy.error));
  check("paid principal + 1% fee + premium from balance", near(before - (await balance(wallet)), Math.round(buy.paid_usd * 1e6)) && near(Math.round(buy.breakdown_usd.credits * 1e6), principal), `${buy.paid_usd}`);
  const daysLeft = (Date.parse(buy.expires_at) - Date.now()) / 86400000;
  check("lands in this month's series, expiring within 3 months", /^\d{4}-\d{2}-open$/.test(buy.series) && daysLeft > 55 && daysLeft <= 92, `${buy.series} ${Math.round(daysLeft)} d`);
  let st = await admin();
  check("reserve got principal + premium (not the fee)", near(Math.round(st.reserve_usd * 100), Math.round((5 + buy.breakdown_usd.credits + buy.breakdown_usd.risk_premium) * 100), 1), `${st.reserve_usd}`);
  check("tracking: 10 credits outstanding, coverage computed", st.outstanding.credits === 10 && st.effective_coverage > st.coverage && st.coverage > 1, `cov ${st.coverage} eff ${st.effective_coverage}`);
  check("stress table present", st.stress.length === 4 && st.stress[3].index_up_pct === 100);
  const mine = await (await req("/v1/credits", { key })).json();
  check("holder sees their credits", mine.yours?.credits === 10 && mine.yours.lots[0].status === "open");

  // Caps and coverage
  await admin({ action: "config", wallet_cap_usd: 6 });
  r = await req("/v1/credits/buy", { key, method: "POST", body: { tier: "open", credits: 5 } });
  check("per-wallet cap enforced", r.status === 409 && (await r.json()).error.code === "wallet_cap_reached");
  await admin({ action: "config", wallet_cap_usd: 250, mint_min_coverage: 100 });
  r = await req("/v1/credits/buy", { key, method: "POST", body: { tier: "open", credits: 1 } });
  check("sales pause when coverage is low", r.status === 409);
  await admin({ action: "config", mint_min_coverage: 1.25 });

  // Using credits (jobs pay with them) is covered by scripts/credit-tiers-test.mjs.
  r = await req("/v1/credits/use", { key, method: "POST", body: { credits: 4 } });
  check("manual use is gone (410)", r.status === 410);

  // Expiry: the 10 credits turn into balance at the tier's price
  await db.from("credit_lots").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("wallet", wallet).eq("status", "open");
  const b2 = await balance(wallet);
  const { data: n2 } = await db.rpc("fuel_credit_expire", { p_unit_usd: 0, p_level: 100 });
  const { data: lot } = await db.from("credit_lots").select("status, units_left_micro").eq("wallet", wallet).single();
  check("expired lot used automatically for the holder", n2 >= 1 && lot.status === "expired" && Number(lot.units_left_micro) === 0 && near((await balance(wallet)) - b2, Math.floor(10e6 * unit), 10));
  st = await admin();
  check("nothing outstanding after expiry", st.outstanding.credits === 0);
  check("admin API needs the token", (await fetch(BASE + "/v1/admin/credits")).status === 401);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  // restore config + reserve exactly, remove test rows
  const cfg = { ...saved };
  delete cfg.id;
  await db.from("credit_config").update(cfg).eq("id", 1);
  await db.from("credit_events").delete().gte("at", startedAt).or(`wallet.eq.${wallet},note.eq.credits-test`);
  if (wallet) {
    await db.from("credit_lots").delete().eq("wallet", wallet);
    for (const t of ["ledger_entries", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", wallet);
    await db.from("accounts").delete().eq("wallet", wallet);
  }
  const { data: after } = await db.from("credit_config").select("enabled, reserve_micro").eq("id", 1).single();
  console.log(`config restored: enabled=${after.enabled} reserve_micro=${after.reserve_micro}`);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
