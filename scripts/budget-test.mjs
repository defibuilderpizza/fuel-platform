// Spending limits in plain words, against a local dev server:
//   node --env-file=.env.local scripts/budget-test.mjs http://localhost:3000
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

const sk = ed25519.utils.randomSecretKey();
const wallet = bs58.encode(ed25519.getPublicKey(sk));
try {
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  const budget = async (text, dry) => {
    const r = await req("/v1/account/budget", { key, method: "POST", body: { text, ...(dry ? { dry_run: true } : {}) } });
    return { status: r.status, j: await r.json() };
  };

  let r = await budget("at most $5 a day, no job over 10 cents");
  check("sets both limits from words", r.status === 200 && r.j.limits.daily_usd === 5 && r.j.limits.per_job_usd === 0.1, r.j.understood);
  check("reports what's left today", r.j.limits.remaining_today_usd === 5);
  r = await budget("remove the daily limit", true);
  check("dry run doesn't save", r.status === 200 && r.j.saved === false && r.j.limits.daily_usd === 5);
  r = await budget("remove the daily limit");
  check("removes one limit, keeps the other", r.j.limits.daily_usd === null && r.j.limits.per_job_usd === 0.1);
  r = await budget("pause spending");
  check("pause sets a $0 daily limit", r.j.limits.daily_usd === 0);
  r = await budget("$20 a week");
  check("weekly amounts are refused with a hint", r.status === 400 && /per day and per job/.test(r.j.error.message) && r.j.error.code === "budget_not_understood");
  r = await budget("spend $3");
  check("ambiguous amounts ask which limit", r.status === 400 && /daily limit or a per-job/.test(r.j.error.message));
  const acct = await (await req("/v1/account", { key })).json();
  check("GET /v1/account shows the saved limits", acct.limits.daily_usd === 0 && acct.limits.per_job_usd === 0.1);
  check("needs a key", (await req("/v1/account/budget", { method: "POST", body: { text: "$1 a day" } })).status === 401);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  for (const t of ["api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", wallet);
  await db.from("accounts").delete().eq("wallet", wallet);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
