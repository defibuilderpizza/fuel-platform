// Capacity contracts (sellers selling compute forward), end to end, against a dev server:
//   node --env-file=.env.local scripts/contracts-test.mjs http://localhost:3000
// Uses Together's endpoint as a stand-in seller (with TOGETHER_API_KEY). Restores the credit
// reserve exactly and deletes everything it creates.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { randomUUID } from "node:crypto";

const BASE = process.argv[2] ?? "http://localhost:3000";
const MODEL = "fuel-test/fwd-gpt";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (path, body) =>
  fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-admin-token": process.env.FUEL_ADMIN_TOKEN }, body: body ? JSON.stringify(body) : undefined });
const cron = () => fetch(BASE + "/api/cron/ring-scan", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }).then((r) => r.json());
const balance = async (w) => Number((await db.from("accounts").select("balance_micro").eq("wallet", w).single()).data.balance_micro);
const reserve = async () => Number((await db.from("credit_config").select("reserve_micro").eq("id", 1).single()).data.reserve_micro);
const listing = (inP, outP, extra = {}) => ({
  name: "Forward Test GPU",
  attest: true,
  endpoint_url: "https://api.together.xyz/v1",
  api_key: process.env.TOGETHER_API_KEY,
  models: [{ model: MODEL, provider_model_id: "openai/gpt-oss-120b", input_per_mtok: inP, output_per_mtok: outP }],
  ...extra,
});

const startedAt = new Date().toISOString();
const reserveBefore = await reserve();
let wallet, sellerId;
try {
  const sk = ed25519.utils.randomSecretKey();
  wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  await db.rpc("fuel_credit_deposit", { p_signature: `contracts-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: 20e6, p_usd_price: null, p_credit: 20e6, p_slot: 0 });

  const ap = await (await req("/v1/sellers", { key, method: "POST", body: listing(0.01, 0.02) })).json();
  sellerId = ap.sellers?.[0]?.id;
  check("seller live (auto-approved)", ap.sellers?.[0]?.status === "approved", ap.sellers?.[0]?.review_note);

  const terms = await (await req("/v1/sellers/contracts", { key })).json();
  check("terms: 30/60/90 days, 20% bond", JSON.stringify(terms.terms.terms_days) === "[30,60,90]" && terms.terms.bond_pct === 20);

  const offer = (body) => req("/v1/sellers/contracts", { key, method: "POST", body: { model: MODEL, term_days: 30, premium_pct: 2, ...body } });
  let r = await offer({ ceiling_in: 0.005, ceiling_out: 0.02, volume_mtok: 100 });
  check("ceiling below current price refused", r.status === 400 && (await r.json()).error.code === "ceiling_below_listing");

  // notional = 100M × (3×0.02 + 0.04)/4 = $2.50; bond 20% = $0.50; premium 2% = $0.05
  let b0 = await balance(wallet);
  r = await offer({ ceiling_in: 0.02, ceiling_out: 0.04, volume_mtok: 100 });
  let o = await r.json();
  check("offer saved; bond taken from balance", r.status === 201 && o.notional_usd === 2.5 && o.bond_usd === 0.5 && o.premium_usd === 0.05 && b0 - (await balance(wallet)) === 500000, JSON.stringify(o));
  r = await offer({ ceiling_in: 0.02, ceiling_out: 0.04, volume_mtok: 100 });
  check("one open contract per model", r.status === 400 && (await r.json()).error.code === "already_committed");
  r = await req(`/v1/sellers/contracts/${o.id}/withdraw`, { key, method: "POST" });
  check("withdraw an offer: bond back", r.status === 200 && (await balance(wallet)) === b0);

  // Breach path
  o = await (await offer({ ceiling_in: 0.02, ceiling_out: 0.04, volume_mtok: 100 })).json();
  r = await admin(`/v1/admin/contracts/${o.id}`, { action: "accept" });
  let { data: c } = await db.from("capacity_contracts").select("status, starts_at, ends_at").eq("id", o.id).single();
  check("admin accepts: active for 30 days", r.status === 200 && c.status === "active" && Math.round((Date.parse(c.ends_at) - Date.parse(c.starts_at)) / 86400000) === 30);
  r = await req("/v1/sellers", { key, method: "POST", body: { ...listing(0.03, 0.02), api_key: undefined } });
  check("raising price above the ceiling is refused", r.status === 409 && (await r.json()).error.code === "above_ceiling");
  r = await req("/v1/sellers", { key, method: "POST", body: { ...listing(0.01, 0.02), api_key: undefined, models: [{ model: "fuel-test/other", provider_model_id: "openai/gpt-oss-120b", input_per_mtok: 0.01, output_per_mtok: 0.02 }] } });
  check("removing a contracted model is refused", r.status === 409 && (await r.json()).error.code === "under_contract");
  const hedge = await (await admin("/v1/admin/contracts")).json();
  check("hedge summary counts the contract", hedge.hedge.active === 1 && hedge.hedge.protected_usd === 2.5, JSON.stringify(hedge.hedge));
  await db.from("seller_models").update({ probe_ok: false, probed_at: new Date().toISOString() }).eq("seller_id", sellerId).eq("model", MODEL);
  await db.from("capacity_contracts").update({ failing_since: new Date(Date.now() - 25 * 3600_000).toISOString() }).eq("id", o.id);
  let rv = await reserve();
  b0 = await balance(wallet);
  let cr = await cron();
  ({ data: c } = await db.from("capacity_contracts").select("status, note").eq("id", o.id).single());
  check("down for 24h+ → breached by the cron", c.status === "breached" && cr.contracts?.breached >= 1, c.note);
  check("breach: bond goes to the reserve, not back", (await reserve()) - rv === 500000 && (await balance(wallet)) === b0);

  // Completion path: volume delivered
  await db.from("seller_models").update({ probe_ok: true, probed_at: new Date().toISOString() }).eq("seller_id", sellerId).eq("model", MODEL);
  o = await (await offer({ ceiling_in: 0.02, ceiling_out: 0.04, volume_mtok: 100 })).json();
  await admin(`/v1/admin/contracts/${o.id}`, { action: "accept" });
  await db.from("jobs").insert({ id: randomUUID(), wallet, model: MODEL, kind: "chat", status: "succeeded", provider: `seller:${sellerId}`, input_tokens: 60_000_000, output_tokens: 40_000_000, created_at: new Date(Date.now() + 1000).toISOString() });
  rv = await reserve();
  b0 = await balance(wallet);
  cr = await cron();
  ({ data: c } = await db.from("capacity_contracts").select("status, used_mtok, note").eq("id", o.id).single());
  check("volume delivered → completed by the cron", c.status === "completed" && Number(c.used_mtok) >= 100, `${c.used_mtok} · ${c.note}`);
  check("completed: bond back + premium paid from the reserve", (await balance(wallet)) - b0 === 550000 && rv - (await reserve()) === 50000);
  check("admin API needs the token", (await fetch(BASE + "/v1/admin/contracts")).status === 401);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  await db.from("credit_config").update({ reserve_micro: reserveBefore }).eq("id", 1);
  await db.from("credit_events").delete().gte("at", startedAt).eq("wallet", wallet ?? "-");
  if (sellerId) {
    await db.from("capacity_contracts").delete().eq("seller_id", sellerId);
    await db.from("provider_models").delete().eq("provider", `seller:${sellerId}`);
    await db.from("sellers").delete().eq("id", sellerId);
  }
  if (wallet) {
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", wallet);
    await db.from("accounts").delete().eq("wallet", wallet);
  }
  console.log(`reserve restored: ${(await reserve()) === reserveBefore}`);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
