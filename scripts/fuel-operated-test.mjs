// Fuel-operated capacity, against a dev server:
//   node --env-file=.env.local scripts/fuel-operated-test.mjs http://localhost:3000
// Lists Together as a stand-in for Fuel's own GPU, marks it Fuel-operated with a locked cost,
// and checks labelling, the no-contracts rule and the admin summary. Cleans up after itself.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const MODEL = "fuel-test/house-gpt";
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

let wallet, sellerId;
try {
  const sk = ed25519.utils.randomSecretKey();
  wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  await db.rpc("fuel_credit_deposit", { p_signature: `house-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: 5e6, p_usd_price: null, p_credit: 5e6, p_slot: 0 });
  const ap = await (await req("/v1/sellers", { key, method: "POST", body: { name: "Fuel RTX 4090 #1", attest: true, endpoint_url: "https://api.together.xyz/v1", api_key: process.env.TOGETHER_API_KEY, models: [{ model: MODEL, provider_model_id: "openai/gpt-oss-120b", input_per_mtok: 0.01, output_per_mtok: 0.02 }] } })).json();
  sellerId = ap.sellers?.[0]?.id;
  check("listing live", ap.sellers?.[0]?.status === "approved");

  let mk = (await (await req("/v1/market")).json()).data.find((r) => r.model === MODEL);
  check("before: counted as an outside seller", mk?.sellers === 1 && mk?.fuel_operated === 0, JSON.stringify(mk && { s: mk.sellers, f: mk.fuel_operated }));

  const until = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  let r = await admin(`/v1/admin/sellers/${sellerId}`, { action: "fuel_operated", operated_by_fuel: true, locked_cost_hr: 0.28, locked_tps: 1500, locked_until: until });
  check("admin marks it Fuel-operated with a locked cost", r.status === 200);

  mk = (await (await req("/v1/market")).json()).data.find((r) => r.model === MODEL);
  check("credit-only: no longer in public market prices", !mk);

  r = await req("/v1/sellers/contracts", { key, method: "POST", body: { model: MODEL, ceiling_in: 0.02, ceiling_out: 0.04, volume_mtok: 100, term_days: 90, premium_pct: 2 } });
  check("no capacity contracts for Fuel-operated GPUs", r.status === 400 && (await r.json()).error.code === "fuel_operated");

  const h = (await (await admin("/v1/admin/contracts")).json()).hedge.fuel_operated.find((x) => x.name === "Fuel RTX 4090 #1");
  // 1500 tok/s = 5.4M tokens/hr; $0.28/hr → ~$0.0519 per 1M at full load; ~90 days ≈ 11.6B tokens
  check("admin shows locked cost, capacity left and cost per 1M", h && h.cost_hr === 0.28 && Math.abs(h.cost_per_mtok_full_load - 0.0519) < 0.001 && h.capacity_left_mtok > 11_000, JSON.stringify(h));

  const sl = (await (await admin("/v1/admin/sellers")).json()).data.find((x) => x.id === sellerId);
  check("admin seller list carries the flag", sl?.operated_by_fuel === true && Number(sl.locked_cost_hr) === 0.28);
  r = await admin(`/v1/admin/sellers/${sellerId}`, { action: "fuel_operated", operated_by_fuel: "yes" });
  check("bad input refused", r.status === 400);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  if (sellerId) {
    await db.from("provider_models").delete().eq("provider", `seller:${sellerId}`);
    await db.from("sellers").delete().eq("id", sellerId);
  }
  if (wallet) {
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", wallet);
    await db.from("accounts").delete().eq("wallet", wallet);
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
