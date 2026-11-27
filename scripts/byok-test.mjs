// Bring-your-own-key, end to end, against a dev server with FUEL_BYOK_PROVIDERS=anthropic:
//   node --env-file=.env.local scripts/byok-test.mjs http://localhost:3000
// Uses ANTHROPIC_API_KEY as the "customer's own key" (run it as the key's owner). Claude must
// have no Fuel route of its own (paused), so jobs go through the customer's key.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OWN = process.env.ANTHROPIC_API_KEY;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + String(extra).slice(0, 110) : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body, headers = {} } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

let wallet;
try {
  const sk = ed25519.utils.randomSecretKey();
  wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  await db.rpc("fuel_credit_deposit", { p_signature: `byok-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: 1e6, p_usd_price: null, p_credit: 1e6, p_slot: 0 });

  let r = await (await req("/v1/byok", { key })).json();
  check("BYOK available for anthropic only", JSON.stringify(r.available) === '["anthropic"]', JSON.stringify(r.available));
  r = await req("/v1/byok", { key, method: "POST", body: { provider: "openai", api_key: "sk-test-xxxxxxxxxxxxxxxxxxxxxxxx" } });
  check("providers not switched on are refused", r.status === 403);
  r = await req("/v1/byok", { key, method: "POST", body: { provider: "anthropic", api_key: "sk-ant-invalid-xxxxxxxxxxxxxxxxxxxxxxxx" } });
  check("a key the provider rejects is not saved", r.status === 400 && (await r.json()).error.code === "byok_key_invalid");
  r = await req("/v1/byok", { key, method: "POST", body: { provider: "anthropic", api_key: OWN } });
  const saved = await r.text();
  check("own key saved, response never contains it", r.status === 201 && !saved.includes(OWN) && saved.includes("…" + OWN.slice(-4)));
  const { data: row } = await db.from("provider_keys").select("key_enc").eq("wallet", wallet).single();
  check("stored encrypted", row.key_enc && !row.key_enc.includes(OWN));

  const before = Number((await db.from("accounts").select("balance_micro").eq("wallet", wallet).single()).data.balance_micro);
  r = await req("/v1/chat/completions", { key, method: "POST", body: { model: "anthropic/claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "Reply with the word ok." }] } });
  const j = await r.json();
  check("job runs on the customer's own key", r.status === 200 && j.fuel?.byok === true && j.fuel?.provider === "anthropic", JSON.stringify(j.fuel ?? j.error));
  const after = Number((await db.from("accounts").select("balance_micro").eq("wallet", wallet).single()).data.balance_micro);
  const fee = Math.round(Number(process.env.FUEL_BYOK_FEE_USD ?? 0) * 1e6);
  check(`Fuel charged only its BYOK fee ($${fee / 1e6}); the provider bills the customer`, before - after === fee && Math.round(j.fuel.price_usd * 1e6) === fee, `${before - after} micro`);
  r = await req("/v1/messages", { key, method: "POST", body: { model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "Reply with the word ok." }] } });
  const m = await r.json();
  check("Claude SDK format works on own key too", r.status === 200 && m.content?.[0]?.text?.length > 0 && m.fuel?.byok === true);
  r = await req("/v1/chat/completions", { key, method: "POST", body: { model: "openai/some-model", max_tokens: 20, messages: [{ role: "user", content: "hi" }] } });
  check("no own key for a provider → model not found", r.status === 404);

  await req("/v1/byok/anthropic", { key, method: "DELETE" });
  r = await req("/v1/chat/completions", { key, method: "POST", body: { model: "anthropic/claude-haiku-5-5", max_tokens: 20, messages: [{ role: "user", content: "hi" }] } });
  check("after removing the key, Claude isn't reachable", r.status === 404);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  if (wallet) {
    await db.from("provider_keys").delete().eq("wallet", wallet);
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", wallet);
    await db.from("accounts").delete().eq("wallet", wallet);
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
