// Free trial without a wallet, against a local dev server with mocks (FUEL_ENABLE_MOCK=1):
//   node --env-file=.env.local scripts/guest-trial-test.mjs http://localhost:3010
// Starts a guest trial, runs a cheap chat job, checks the limits (dear models, video, other
// endpoints), the one-per-network rule, and that running out asks for a wallet. Cleans up.
import "./test-guard.mjs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const BASE = process.argv.find((a) => /^https?:\/\//.test(a)) ?? "http://localhost:3010";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const IP = `203.0.113.${Math.floor(Math.random() * 200) + 1}`; // test-net address, so the real one is untouched
const IP2 = `203.0.113.${Math.floor(Math.random() * 50) + 201}`;
const req = (path, { key, method = "GET", body, ip = IP, cookie } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const MODEL = "fuel-test/mock-chat";
const DEAR = "fuel-test/mock-dear";
let wallet;
let wallet2;
const ipHash = (ip) => createHash("sha256").update(`fuel-guest:ip:${process.env.FUEL_SECRETS_KEY ?? ""}:${ip}`).digest("hex");
try {
  await db.from("provider_models").upsert(
    [
      { model: MODEL, kind: "chat", provider: "mock", provider_model_id: "ok", input_per_mtok: 0.2, output_per_mtok: 0.6 },
      { model: DEAR, kind: "chat", provider: "mock", provider_model_id: "ok", input_per_mtok: 3, output_per_mtok: 15 },
    ],
    { onConflict: "model,provider" },
  );
  let r = await req("/v1/trial/start", { method: "POST" });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  const t = await r.json();
  check("the computer gets a device cookie", /^fuel_device=/.test(cookie), cookie);
  check("start a trial with no wallet", r.status === 201 && t.api_key?.startsWith("fuel_sk_") && t.credits_usd > 0, JSON.stringify(t.error ?? t.credits_usd));
  const key = t.api_key;
  const acct = await (await req("/v1/account", { key })).json();
  wallet = acct.wallet;
  check("guest account is a guest: wallet with the credits", wallet?.startsWith("guest:") && acct.balance_usd === t.credits_usd);

  r = await req("/v1/chat/completions", { key, method: "POST", body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
  check("cheap text model runs", r.status === 200, String(r.status));
  r = await req("/v1/chat/completions", { key, method: "POST", body: { model: DEAR, messages: [{ role: "user", content: "hi" }] } });
  check("dear model refused, asks for a wallet", r.status === 403 && /Sign in with a wallet/.test((await r.json()).error.message));
  r = await req("/v1/videos", { key, method: "POST", body: { model: "Lightricks/LTX-Video", prompt: "x" } });
  check("video isn't part of the trial", r.status === 403);
  r = await req("/v1/teams", { key });
  check("other endpoints refused for guest keys", r.status === 403 && (await r.json()).error.code === "guest_trial");

  r = await req("/v1/trial/start", { method: "POST" });
  check("one trial per network", r.status === 409 && (await r.json()).error.code === "trial_used");
  r = await req("/v1/trial/start", { method: "POST", ip: IP2, cookie });
  check("one trial per computer, even from another network", r.status === 409 && (await r.json()).error.code === "trial_used");
  r = await req("/v1/trial/start", { method: "POST", ip: IP2 });
  const t2 = await r.json();
  check("another computer on another network can still try", r.status === 201);
  if (t2.api_key) wallet2 = (await (await req("/v1/account", { key: t2.api_key, ip: IP2 })).json()).wallet;

  await db.from("accounts").update({ balance_micro: 0 }).eq("wallet", wallet);
  r = await req("/v1/chat/completions", { key, method: "POST", body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
  check("out of credits → 402 (the studio then asks to sign in and top up)", r.status === 402);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  await db.from("guest_trials").delete().in("ip_hash", [ipHash(IP), ipHash(IP2)]);
  for (const w of [wallet, wallet2].filter(Boolean)) {
    for (const t of ["faucet_trials", "ledger_entries", "jobs", "api_keys"]) await db.from(t).delete().eq("wallet", w);
    await db.from("accounts").delete().eq("wallet", w);
  }
  await db.from("provider_models").delete().in("model", [MODEL, DEAR]);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
