// Fuel's GPU selling spare capacity at the market rate, against a dev server:
//   node --env-file=.env.local scripts/house-market-test.mjs http://localhost:3000
// Uses Together as the stand-in for every endpoint. Checks: independent sellers win ties,
// Fuel's GPU beats hosted providers at the same price, never serves a model nobody else sells,
// respects the share promised to credits, and gives credit money its discount.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const MODEL = "fuel-test/hm-gpt";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (path, { key, method = "GET", body } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (path, body) =>
  fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-admin-token": process.env.FUEL_ADMIN_TOKEN }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
async function newWallet(fund) {
  const sk = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  if (fund) await db.rpc("fuel_credit_deposit", { p_signature: `hm-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: fund * 1e6, p_usd_price: null, p_credit: fund * 1e6, p_slot: 0 });
  return { wallet, key };
}
const listing = (name, inP, outP) => ({ name, attest: true, endpoint_url: "https://api.together.xyz/v1", api_key: process.env.TOGETHER_API_KEY, models: [{ model: MODEL, provider_model_id: "openai/gpt-oss-120b", input_per_mtok: inP, output_per_mtok: outP }] });
const chat = async (key) => {
  const r = await req("/v1/chat/completions", { key, method: "POST", body: { model: MODEL, max_tokens: 32, messages: [{ role: "user", content: "Say ok" }] } });
  return { status: r.status, j: await r.json() };
};

const { data: saved } = await db.from("credit_config").select("*").eq("id", 1).single();
const startedAt = new Date().toISOString();
const wallets = [];
const sellerIds = [];
let hostedRow = false;
try {
  const houseW = await newWallet(1);
  const sellerW = await newWallet(1);
  const agent = await newWallet(10);
  const buyer = await newWallet(10);
  wallets.push(houseW.wallet, sellerW.wallet, agent.wallet, buyer.wallet);

  const h = await (await req("/v1/sellers", { key: houseW.key, method: "POST", body: listing("Fuel GPU", 0.01, 0.02) })).json();
  const houseId = h.sellers[0].id;
  sellerIds.push(houseId);
  await admin(`/v1/admin/sellers/${houseId}`, { action: "fuel_operated", operated_by_fuel: true, locked_cost_hr: 0.28, locked_tps: 1500, locked_until: new Date(Date.now() + 100 * 86400000).toISOString() });
  await admin("/v1/admin/credits", { action: "config", house_market: true, promise_share: 0.35 });

  let r = await chat(agent.key);
  check("model only Fuel's GPU serves: not sold to the market", r.status === 404);

  // An independent seller at a higher price than Fuel's GPU lists
  const s = await (await req("/v1/sellers", { key: sellerW.key, method: "POST", body: listing("Indie GPU", 0.012, 0.025) })).json();
  const sellerId = s.sellers[0].id;
  sellerIds.push(sellerId);
  r = await chat(agent.key);
  check("independent seller wins (Fuel's GPU only matches its price, never undercuts)", r.status === 200 && r.j.fuel?.provider === `seller:${sellerId}`, r.j.fuel?.provider);

  // Swap the indie seller for a hosted provider at the same kind of price
  await admin(`/v1/admin/sellers/${sellerId}`, { action: "pause", note: "test" });
  await db.from("provider_models").upsert({ model: MODEL, kind: "chat", provider: "together", provider_model_id: "openai/gpt-oss-120b", input_per_mtok: 0.015, output_per_mtok: 0.03, enabled: true, updated_at: new Date().toISOString() }, { onConflict: "model,provider" });
  hostedRow = true;
  r = await chat(agent.key);
  const marketPrice = (u) => Math.ceil((Math.ceil(u.input_tokens * 0.015) + Math.ceil(u.output_tokens * 0.03)) * 1.1);
  check("Fuel's spare GPU takes the job from the hosted provider at the same price", r.status === 200 && r.j.fuel?.provider === `seller:${houseId}`, r.j.fuel?.provider);
  const { data: job } = await db.from("jobs").select("credit_funded, price_micro, input_tokens, output_tokens").eq("id", r.j.fuel.job_id).single();
  check("charged the market rate (+10%), recorded as a market job", !job.credit_funded && Math.abs(Number(job.price_micro) - marketPrice(job)) <= 1, `${job.price_micro} vs ${marketPrice(job)}`);

  // Spare capacity used up: shrink the GPU so the last hour's market tokens exceed 65% of it
  await db.from("sellers").update({ locked_tps: 0.001 }).eq("id", houseId);
  console.log("      (waiting 32 s for the spare-capacity cache)");
  await sleep(32_000);
  r = await chat(agent.key);
  check("no spare capacity left: the market job goes to the hosted provider", r.status === 200 && r.j.fuel?.provider === "together", r.j.fuel?.provider);
  await db.from("sellers").update({ locked_tps: 1500 }).eq("id", houseId);

  // Credit money: Fuel's GPU first, with the discount
  await admin("/v1/admin/credits", { action: "config", enabled: true, require_locked_capacity: true });
  const b = await req("/v1/credits/buy", { key: buyer.key, method: "POST", body: { tier: "open", credits: 2 } });
  check("credits bought", b.status === 201);
  r = await chat(buyer.key);
  const { data: cj } = await db.from("jobs").select("credit_funded, price_micro, input_tokens, output_tokens").eq("id", r.j.fuel?.job_id).single();
  check("credit-paid job runs on Fuel's GPU even with no spare capacity", r.status === 200 && r.j.fuel?.provider === `seller:${houseId}` && cj.credit_funded === true, r.j.fuel?.provider);
  const discounted = Math.ceil((marketPrice(cj) * 9000) / 10000);
  check("credit-paid jobs get 10% off on Fuel's GPU", Math.abs(Number(cj.price_micro) - discounted) <= 1, `${cj.price_micro} vs ${discounted}`);

  const st = await admin("/v1/admin/credits");
  const g = st.locked.items.find((x) => x.name === "Fuel GPU");
  check("admin splits the GPU's last 24 h into credits vs market", g && g.credit_24h.usd > 0 && g.market_24h.usd > 0, JSON.stringify(g && { c: g.credit_24h, m: g.market_24h }));
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  const cfg = { ...saved };
  delete cfg.id;
  await db.from("credit_config").update(cfg).eq("id", 1);
  await db.from("credit_events").delete().gte("at", startedAt);
  if (hostedRow) await db.from("provider_models").delete().eq("model", MODEL).eq("provider", "together");
  for (const id of sellerIds) {
    await db.from("provider_models").delete().eq("provider", `seller:${id}`);
    await db.from("sellers").delete().eq("id", id);
  }
  for (const w of wallets) {
    const { data: holds } = await db.from("credit_job_holds").select("job_id").eq("wallet", w);
    for (const h of holds ?? []) await db.from("credit_job_takes").delete().eq("job_id", h.job_id);
    await db.from("credit_job_holds").delete().eq("wallet", w);
    await db.from("credit_lots").delete().eq("wallet", w);
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", w);
    await db.from("accounts").delete().eq("wallet", w);
  }
  const { data: left } = await db.from("provider_models").select("provider").eq("model", MODEL);
  console.log(`config restored, test routes left: ${left?.length ?? 0}`);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
