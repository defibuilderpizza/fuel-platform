// Local end-to-end check of the core loop using the test-only mock providers.
// Run: FUEL_ENABLE_MOCK=1 npm run dev   (in another terminal), then:
//      node --env-file=.env.local scripts/smoke.mjs [baseUrl]
// Creates a throwaway wallet, credits it a fake $1 deposit, runs jobs, checks
// failover/limits/receipts, then deletes everything it created.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const MODEL = "fuel-test/mock-chat";
const EMB = "fuel-test/mock-embed";
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failures++; };
const api = (path, { key, ...init } = {}) =>
  fetch(BASE + path, { ...init, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) } });

const secret = ed25519.utils.randomSecretKey();
const wallet = bs58.encode(ed25519.getPublicKey(secret));
const fakeSig = "smoke-" + wallet;

try {
  // Catalogue: a broken provider that is cheapest (tried first) + a working one.
  await db.from("provider_models").upsert([
    { model: MODEL, kind: "chat", provider: "mock-down", provider_model_id: "down", input_per_mtok: 0.1, output_per_mtok: 0.1 },
    { model: MODEL, kind: "chat", provider: "mock", provider_model_id: "ok", input_per_mtok: 0.2, output_per_mtok: 0.6 },
    { model: EMB, kind: "embedding", provider: "mock", provider_model_id: "emb", input_per_mtok: 0.02, output_per_mtok: 0 },
  ], { onConflict: "model,provider" });

  // Sign in with the wallet → API key
  const n = await (await api("/v1/auth/nonce", { method: "POST", body: JSON.stringify({ wallet }) })).json();
  check("nonce issued", typeof n.message === "string");
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), secret));
  const badSig = bs58.encode(ed25519.sign(new TextEncoder().encode("other"), secret));
  const bad = await api("/v1/auth/keys", { method: "POST", body: JSON.stringify({ wallet, nonce: n.nonce, signature: badSig }) });
  check("wrong signature rejected", bad.status === 401);
  const n2 = await (await api("/v1/auth/nonce", { method: "POST", body: JSON.stringify({ wallet }) })).json();
  const sig2 = bs58.encode(ed25519.sign(new TextEncoder().encode(n2.message), secret));
  const k = await api("/v1/auth/keys", { method: "POST", body: JSON.stringify({ wallet, nonce: n2.nonce, signature: sig2, label: "smoke" }) });
  const { api_key: key } = await k.json();
  check("api key issued", k.status === 201 && key?.startsWith("fuel_sk_"));
  const replay = await api("/v1/auth/keys", { method: "POST", body: JSON.stringify({ wallet, nonce: n2.nonce, signature: sig2 }) });
  check("nonce can't be reused", replay.status === 401);
  void sig;

  check("no key → 401", (await api("/v1/account")).status === 401);
  const broke = await api("/v1/chat/completions", { key, method: "POST", body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
  check("zero balance → 402", broke.status === 402);

  // Fake $1 deposit straight through the DB function (the on-chain path needs a real transfer)
  const { data: credited } = await db.rpc("fuel_credit_deposit", { p_signature: fakeSig, p_wallet: wallet, p_asset: "USDC", p_amount_raw: 1_000_000, p_usd_price: null, p_credit: 1_000_000, p_slot: 0 });
  const { data: again } = await db.rpc("fuel_credit_deposit", { p_signature: fakeSig, p_wallet: wallet, p_asset: "USDC", p_amount_raw: 1_000_000, p_usd_price: null, p_credit: 1_000_000, p_slot: 0 });
  check("deposit credited once only", credited === true && again === false);
  let acct = await (await api("/v1/account", { key })).json();
  check("balance $1", acct.balance_usd === 1, JSON.stringify({ balance: acct.balance_usd }));

  const models = await (await api("/v1/models")).json();
  const m = models.data?.find((x) => x.id === MODEL);
  check("model listed with marked-up price", m && m.pricing.input_per_mtok_usd > 0.1, JSON.stringify(m?.pricing));

  // Non-streaming chat: mock-down fails first, falls over to mock
  const r = await api("/v1/chat/completions", { key, method: "POST", body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
  const j = await r.json();
  check("chat ok via failover", r.status === 200 && j.fuel?.provider === "mock" && j.fuel?.attempts === 2, JSON.stringify(j.fuel));
  check("response model is Fuel's name", j.model === MODEL);

  // Streaming
  const s = await api("/v1/chat/completions", { key, method: "POST", body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] }) });
  const text = await s.text();
  check("stream ok", s.status === 200 && text.includes("[DONE]") && !!s.headers.get("x-fuel-job-id"));
  const sj = await (await api(`/v1/jobs/${s.headers.get("x-fuel-job-id")}`, { key })).json();
  check("stream settled with usage", sj.status === "succeeded" && sj.output_tokens === 8 && sj.price_usd > 0, JSON.stringify(sj));

  // Embeddings
  const e = await api("/v1/embeddings", { key, method: "POST", body: JSON.stringify({ model: EMB, input: ["a", "b"] }) });
  const ej = await e.json();
  check("embeddings ok", e.status === 200 && ej.data?.length === 2 && ej.fuel?.price_usd > 0);

  check("unknown model → 404", (await api("/v1/chat/completions", { key, method: "POST", body: JSON.stringify({ model: "nope", messages: [] }) })).status === 404);

  // Limits
  await api("/v1/account", { key, method: "PATCH", body: JSON.stringify({ per_job_usd: 0.000001 }) });
  const lim = await api("/v1/chat/completions", { key, method: "POST", body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
  check("per-job limit enforced", lim.status === 402 && (await lim.json()).error.code === "per_job_limit");
  await api("/v1/account", { key, method: "PATCH", body: JSON.stringify({ per_job_usd: null, daily_usd: 0 }) });
  const day = await api("/v1/chat/completions", { key, method: "POST", body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
  check("daily limit enforced", day.status === 402 && (await day.json()).error.code === "daily_limit");

  // Money adds up: balance = 1 - sum(charges), nothing left held
  acct = await (await api("/v1/account", { key })).json();
  const jobs = (await (await api("/v1/jobs", { key })).json()).data;
  const spent = jobs.reduce((t, x) => t + x.price_usd, 0);
  check("ledger balances", Math.abs(acct.balance_usd - (1 - spent)) < 1e-9 && acct.held_usd === 0, JSON.stringify({ balance: acct.balance_usd, spent, held: acct.held_usd, jobs: jobs.length }));
  const { data: ledger } = await db.from("ledger_entries").select("delta_micro").eq("wallet", wallet);
  const ledgerSum = ledger.reduce((t, x) => t + Number(x.delta_micro), 0);
  check("ledger sum = balance", ledgerSum / 1e6 === acct.balance_usd);

  // Receipts never hold content
  const { data: raw } = await db.from("jobs").select("*").eq("wallet", wallet).limit(1);
  check("receipt has no content fields", raw && !JSON.stringify(raw).includes("Mock reply") && !JSON.stringify(raw).includes('"hi"'));

  // Revoke
  const keys = (await (await api("/v1/auth/keys", { key })).json()).data;
  await api(`/v1/auth/keys/${keys[0].id}`, { key, method: "DELETE" });
  check("revoked key stops working", (await api("/v1/account", { key })).status === 401);
} finally {
  for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", wallet);
  await db.from("accounts").delete().eq("wallet", wallet);
  await db.from("provider_models").delete().like("model", "fuel-test/%");
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exitCode = failures ? 1 : 0;
}
