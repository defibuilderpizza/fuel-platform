// Credits backed by Fuel's own locked GPU, against a dev server:
//   node --env-file=.env.local scripts/credit-capacity-test.mjs http://localhost:3000
// Lists Together as a stand-in for Fuel's rented GPU (credit-only), then checks: it's not in
// public prices, credit sales are capped by its promised capacity, only credit-funded jobs run
// on it, and the risk numbers count it. Restores config and deletes what it creates.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const MODEL = "fuel-test/credit-gpt";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body, headers = {} } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (path, body) =>
  fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-admin-token": process.env.FUEL_ADMIN_TOKEN }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
async function newWallet(fund) {
  const sk = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  if (fund) await db.rpc("fuel_credit_deposit", { p_signature: `cap-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: fund * 1e6, p_usd_price: null, p_credit: fund * 1e6, p_slot: 0 });
  return { wallet, key };
}
const chat = (key, headers = {}) => req("/v1/chat/completions", { key, method: "POST", headers, body: { model: MODEL, max_tokens: 32, messages: [{ role: "user", content: "Say ok" }] } });
const funded = async (w) => Number((await db.from("accounts").select("credit_funded_micro").eq("wallet", w).single()).data.credit_funded_micro);

const { data: saved } = await db.from("credit_config").select("*").eq("id", 1).single();
const startedAt = new Date().toISOString();
const wallets = [];
let sellerId;
try {
  // Fuel's "rented GPU": listed, then marked Fuel-operated with a locked cost until +100 days
  const house = await newWallet(1);
  wallets.push(house.wallet);
  const ap = await (await req("/v1/sellers", { key: house.key, method: "POST", body: { name: "Fuel credits GPU", attest: true, endpoint_url: "https://api.together.xyz/v1", api_key: process.env.TOGETHER_API_KEY, models: [{ model: MODEL, provider_model_id: "openai/gpt-oss-120b", input_per_mtok: 0.01, output_per_mtok: 0.02 }] } })).json();
  sellerId = ap.sellers?.[0]?.id;
  await admin(`/v1/admin/sellers/${sellerId}`, { action: "fuel_operated", operated_by_fuel: true, locked_cost_hr: 0.28, locked_tps: 1500, locked_until: new Date(Date.now() + 100 * 86400000).toISOString() });

  const mk = (await (await req("/v1/market")).json()).data.find((r) => r.model === MODEL);
  check("credit-only GPU is not in public market prices", !mk);
  const models = (await (await req("/v1/models")).json()).data.map((m) => m.id);
  check("…nor in the public model list", !models.includes(MODEL));

  const buyer = await newWallet(20);
  const other = await newWallet(5);
  wallets.push(buyer.wallet, other.wallet);
  let r = await chat(other.key);
  check("a normal paying agent is never routed to Fuel's credit GPU", r.status === 404);

  await admin("/v1/admin/credits", { action: "config", enabled: true, require_locked_capacity: true, promise_share: 0.35, cap_usd: 2500, wallet_cap_usd: 250, mint_min_coverage: 1.25, redeem_limit_coverage: 1.1, redeem_daily_usd: 50, fee_bps: 100, premium_max_bps: 300 });
  await db.from("credit_config").update({ reserve_micro: 0 }).eq("id", 1);
  let st = await admin("/v1/admin/credits");
  // 1500 tok/s × ~100 days ≈ 12,960M tokens; 35% promised ≈ 4,536M × $0.0125 ≈ $56.7
  check("locked capacity valued from the GPU's promised tokens", st.locked.value_usd > 50 && st.locked.value_usd < 60 && st.locked.items[0].promised_mtok > 4400, JSON.stringify({ v: st.locked.value_usd, p: st.locked.items[0]?.promised_mtok }));
  check("selling opens with an empty reserve, because credits are fully backed", st.selling.open === true, st.selling.reason);

  r = await req("/v1/credits/buy", { key: buyer.key, method: "POST", body: { tier: "open", credits: 10 } });
  check("bought 10 credits", r.status === 201, JSON.stringify((await r.json()).error ?? ""));
  st = await admin("/v1/admin/credits");
  check("risk: all of it backed by locked capacity, none on the reserve", st.locked.backed_pct === 100 && st.locked.unbacked_usd === 0 && st.stress.every((s) => s.cost_usd === 0), JSON.stringify(st.locked));

  await admin("/v1/admin/credits", { action: "config", promise_share: 0.001 });
  r = await req("/v1/credits/buy", { key: buyer.key, method: "POST", body: { tier: "open", credits: 1 } });
  st = await admin("/v1/admin/credits");
  check("sales stop once promised capacity is sold", r.status === 409 && /promised capacity/.test(st.selling.reason), st.selling.reason);
  check("risk: credits beyond the promise count as unbacked", st.locked.unbacked_usd > 0 && st.stress[1].cost_usd > 0);
  await admin("/v1/admin/credits", { action: "config", promise_share: 0.35 });

  r = await chat(buyer.key, { "x-fuel-credits": "off" });
  check("paying from balance: not routed to the credit GPU", r.status === 404, `${r.status} ${JSON.stringify((await r.clone().json().catch(() => ({}))).fuel?.provider ?? "")}`);
  r = await chat(buyer.key);
  const j = await r.json();
  check("job paid with credits runs on Fuel's credit GPU", r.status === 200 && j.fuel?.provider === `seller:${sellerId}` && j.fuel?.paid_with_credits?.tier === "open", JSON.stringify(j.fuel ?? j.error));
  const { data: cj } = await db.from("jobs").select("credit_funded").eq("id", j.fuel.job_id).single();
  check("the job is marked credit-funded", cj.credit_funded === true);
  void funded;
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  const cfg = { ...saved };
  delete cfg.id;
  await db.from("credit_config").update(cfg).eq("id", 1);
  await db.from("credit_events").delete().gte("at", startedAt);
  if (sellerId) {
    await db.from("provider_models").delete().eq("provider", `seller:${sellerId}`);
    await db.from("sellers").delete().eq("id", sellerId);
  }
  for (const w of wallets) {
    const { data: holds } = await db.from("credit_job_holds").select("job_id").eq("wallet", w);
    for (const h of holds ?? []) await db.from("credit_job_takes").delete().eq("job_id", h.job_id);
    await db.from("credit_job_holds").delete().eq("wallet", w);
    await db.from("credit_lots").delete().eq("wallet", w);
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", w);
    await db.from("accounts").delete().eq("wallet", w);
  }
  const { data: a } = await db.from("credit_config").select("enabled, reserve_micro, promise_share").eq("id", 1).single();
  console.log(`config restored: ${JSON.stringify(a)}`);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
