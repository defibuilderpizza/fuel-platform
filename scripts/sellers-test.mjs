// GPU / endpoint seller check, end to end, against a dev server:
//   node --env-file=.env.local scripts/sellers-test.mjs http://localhost:3000
// Uses Together's public OpenAI-compatible endpoint as a stand-in "seller" (with TOGETHER_API_KEY),
// listed under a test model name and priced below Together so the router picks it.
// Covers: endpoint safety, encrypted key, correctness tests, automatic approval, routing,
// seller payout, health re-tests (drop out / come back), admin pause.
// Runs one real 1-token-ish job (a fraction of a cent). Deletes everything it creates.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const MODEL = "fuel-test/seller-gpt";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
async function newWallet() {
  const sk = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const k = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  return { wallet, key: k.api_key };
}
const listing = (endpoint, extra = {}) => ({
  name: "Test GPU Co",
  attest: true,
  endpoint_url: endpoint,
  api_key: process.env.TOGETHER_API_KEY,
  contact: "test",
  models: [{ model: MODEL, provider_model_id: "openai/gpt-oss-120b", input_per_mtok: 0.01, output_per_mtok: 0.02 }],
  ...extra,
});

const wallets = [];
let sellerId = null;
try {
  const seller = await newWallet();
  const agent = await newWallet();
  wallets.push(seller.wallet, agent.wallet);

  // Endpoint safety
  for (const [label, url] of [
    ["http (not https)", "http://api.together.xyz/v1"],
    ["localhost", "https://localhost:8000/v1"],
    ["loopback IP", "https://127.0.0.1/v1"],
    ["private IP", "https://10.0.0.5/v1"],
    ["cloud metadata IP", "https://169.254.169.254/latest"],
    ["hostname resolving to 127.0.0.1", "https://localtest.me/v1"],
  ]) {
    const r = await req("/v1/sellers", { key: seller.key, method: "POST", body: listing(url) });
    check(`rejects ${label}`, r.status === 400, (await r.json()).error?.message);
  }
  check("needs an API key", (await req("/v1/sellers", { method: "POST", body: listing("https://api.together.xyz/v1") })).status === 401);

  // Commercial model APIs can't be listed as seller endpoints; sellers must attest
  for (const [label, url] of [
    ["OpenAI", "https://api.openai.com/v1"],
    ["Anthropic", "https://api.anthropic.com/v1"],
    ["Google", "https://generativelanguage.googleapis.com/v1beta/openai"],
    ["OpenRouter", "https://openrouter.ai/api/v1"],
    ["Azure OpenAI (subdomain)", "https://myco.openai.azure.com/openai"],
  ]) {
    const r = await req("/v1/sellers", { key: seller.key, method: "POST", body: listing(url) });
    check(`refuses ${label} as a seller endpoint`, r.status === 400 && /commercial model API/.test((await r.json()).error?.message ?? ""));
  }
  const noAttest = await req("/v1/sellers", { key: seller.key, method: "POST", body: { ...listing("https://api.together.xyz/v1"), attest: undefined } });
  check("requires the attestation", noAttest.status === 400 && (await noAttest.json()).error?.code === "attestation_required");

  // Apply with a real public endpoint: one good model, one that doesn't exist there
  const BAD = "fuel-test/seller-missing";
  const a = await req("/v1/sellers", {
    key: seller.key,
    method: "POST",
    body: listing("https://api.together.xyz/v1/", {
      models: [
        { model: MODEL, provider_model_id: "openai/gpt-oss-120b", input_per_mtok: 0.01, output_per_mtok: 0.02 },
        { model: BAD, provider_model_id: "nobody/no-such-model", input_per_mtok: 0.01, output_per_mtok: 0.02 },
      ],
    }),
  });
  const aj = await a.json();
  sellerId = aj.sellers?.[0]?.id;
  const pr = Object.fromEntries((aj.probes ?? []).map((p) => [p.model, p]));
  check("good model passes the correctness test (17 + 25)", pr[MODEL]?.ok === true, JSON.stringify(pr[MODEL]));
  check("missing model fails its test", pr[BAD]?.ok === false, pr[BAD]?.error);
  check("approved automatically, no human review", a.status === 201 && aj.sellers[0].status === "approved" && aj.sellers[0].endpoint_url === "https://api.together.xyz/v1", aj.sellers?.[0]?.review_note);
  const { data: raw } = await db.from("sellers").select("api_key_enc").eq("id", sellerId).single();
  check("API key stored encrypted, never returned", !!raw.api_key_enc && !raw.api_key_enc.includes(process.env.TOGETHER_API_KEY) && !JSON.stringify(aj).includes(process.env.TOGETHER_API_KEY));
  const routedNow = async () => (await db.from("provider_models").select("model, enabled").eq("provider", `seller:${sellerId}`)).data ?? [];
  const live = (rows, m) => rows.some((x) => x.model === m && x.enabled);
  let rows = await routedNow();
  check("only the passing model is routed", live(rows, MODEL) && !live(rows, BAD), JSON.stringify(rows));

  // A real job goes to the seller; the seller is paid its own price
  await db.rpc("fuel_credit_deposit", { p_signature: `sellers-test-${agent.wallet}`, p_wallet: agent.wallet, p_asset: "USDC", p_amount_raw: 1e6, p_usd_price: null, p_credit: 1e6, p_slot: 0 });
  const r = await req("/v1/chat/completions", { key: agent.key, method: "POST", body: { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "Say ok" }] } });
  const rj = await r.json();
  check("job routed to the seller", r.status === 200 && rj.fuel?.provider === `seller:${sellerId}`, JSON.stringify(rj.fuel ?? rj.error));
  const { data: job } = await db.from("jobs").select("provider_cost_micro, price_micro").eq("id", rj.fuel?.job_id).single();
  const me = await (await req("/v1/sellers/me", { key: seller.key })).json();
  check("seller paid its listed price (Fuel keeps the markup)", me.earned_usd > 0 && Math.abs(me.earned_usd - job.provider_cost_micro / 1e6) < 1e-9 && job.price_micro > job.provider_cost_micro, JSON.stringify({ earned: me.earned_usd, cost: job.provider_cost_micro, charged: job.price_micro }));
  check("jobs served counted", me.sellers[0].jobs_served === 1);
  const sellerAcct = await (await req("/v1/account", { key: seller.key })).json();
  check("earnings land in the seller's balance", Math.abs(sellerAcct.balance_usd - me.earned_usd) < 1e-9);

  // Health checks: a model that breaks leaves routing; when it's fixed it comes back
  const ADMIN = process.env.FUEL_ADMIN_TOKEN;
  const admin = (path, body) => fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-admin-token": ADMIN }, body: body ? JSON.stringify(body) : undefined });
  await db.from("seller_models").update({ provider_model_id: "nobody/broken-now" }).eq("seller_id", sellerId).eq("model", MODEL);
  await admin(`/v1/admin/sellers/${sellerId}`, { action: "probe" });
  rows = await routedNow();
  check("broken model drops out of routing on re-test", !live(rows, MODEL), JSON.stringify(rows));
  const gone = await req("/v1/chat/completions", { key: agent.key, method: "POST", body: { model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Say ok" }] } });
  check("agents can't be routed to it meanwhile", gone.status === 404);
  await db.from("seller_models").update({ provider_model_id: "openai/gpt-oss-120b" }).eq("seller_id", sellerId).eq("model", MODEL);
  await admin(`/v1/admin/sellers/${sellerId}`, { action: "probe" });
  rows = await routedNow();
  check("fixed model comes back on its own", live(rows, MODEL), JSON.stringify(rows));

  // Admin override: a pause sticks, even through edits and re-tests
  check("admin API needs the token", (await fetch(BASE + "/v1/admin/sellers")).status === 401);
  await admin(`/v1/admin/sellers/${sellerId}`, { action: "pause", note: "test pause" });
  await req("/v1/sellers", { key: seller.key, method: "POST", body: { ...listing("https://api.together.xyz/v1"), api_key: undefined, name: "Test GPU Co 2" } });
  await admin(`/v1/admin/sellers/${sellerId}`, { action: "probe" });
  const after = await (await req("/v1/sellers/me", { key: seller.key })).json();
  rows = await routedNow();
  check("admin pause sticks through edits and re-tests", after.sellers[0].status === "paused" && after.sellers[0].has_api_key && rows.every((x) => !x.enabled), JSON.stringify({ status: after.sellers[0].status, rows }));
  const list = await (await admin("/v1/admin/sellers")).json();
  check("admin list shows the seller without its key", list.data?.some((x) => x.id === sellerId && x.has_api_key && !("api_key_enc" in x)));
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  if (sellerId) {
    await db.from("provider_models").delete().eq("provider", `seller:${sellerId}`);
    await db.from("sellers").delete().eq("id", sellerId);
  }
  for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().in("wallet", wallets);
  await db.from("accounts").delete().in("wallet", wallets);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
