// Credit faucet check ($1 trial, 2% of deposits): trial, pay-later limit, repayment, overdue freeze, pot cap.
// Needs a dev server with FUEL_ENABLE_MOCK=1:  node --env-file=.env.local scripts/faucet-test.mjs http://localhost:3000
// Uses throwaway wallets and a pricey mock model; restores the faucet config and deletes everything.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const MODEL = "fuel-test/pricey";
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
let dep = 0;
const deposit = (wallet, usd) => db.rpc("fuel_credit_deposit", { p_signature: `faucet-test-${wallet}-${dep++}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: Math.round(usd * 1e6), p_usd_price: null, p_credit: Math.round(usd * 1e6), p_slot: 0 });
const job = (key) => req("/v1/chat/completions", { key, method: "POST", body: { model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "hi" }] } });
const acct = async (key) => (await req("/v1/account", { key })).json();
const bal = async (wallet) => Number((await db.from("accounts").select("balance_micro").eq("wallet", wallet).single()).data.balance_micro);

const wallets = [];
const { data: cfg0 } = await db.from("faucet_config").select("*").eq("id", 1).single();
try {
  // $0.001 per input token (+8% markup) and nothing for output: each mock job costs ~$0.022.
  await db.from("provider_models").upsert([{ model: MODEL, kind: "chat", provider: "mock", provider_model_id: "ok", input_per_mtok: 1000, output_per_mtok: 0 }], { onConflict: "model,provider" });
  const a = await newWallet();
  wallets.push(a.wallet);

  // Any wallet can claim the trial now (no on-chain history needed; the pot caps the total).
  const claim = await req("/v1/faucet/claim", { key: a.key, method: "POST" });
  check("any wallet, even a brand-new one, can claim the trial", claim.status === 201, String(claim.status));
  const again = await req("/v1/faucet/claim", { key: a.key, method: "POST" });
  check("trial only once per wallet", again.status === 409 && (await again.json()).error.code === "already_claimed");
  let f = (await req("/v1/faucet", { key: a.key }).then((r) => r.json()));
  check("trial shows $1, no credit without deposits", f.trial.claimed && f.credit.limit_usd === 0 && (await bal(a.wallet)) === 1000000, JSON.stringify(f.credit));

  // Spend the trial: with no top-ups, the balance can't go below zero.
  let n = 0;
  while (n < 400 && (await job(a.key)).ok) n++;
  const afterTrial = await bal(a.wallet);
  check("trial spent, balance never negative without top-ups", n >= 3 && afterTrial >= 0, `${n} jobs, balance ${afterTrial}`);

  // Deposit $5: credit = 2% × $5 = $0.10.
  await deposit(a.wallet, 5);
  f = await req("/v1/faucet", { key: a.key }).then((r) => r.json());
  check("credit limit = 2% of previous deposits", f.credit.limit_usd === 0.1, JSON.stringify({ limit: f.credit.limit_usd, paid_total: f.credit.paid_in_total_usd }));
  n = 0;
  while (n < 400 && (await job(a.key)).ok) n++;
  const owed = await bal(a.wallet);
  check("ran into credit, stopped at the limit", owed < 0 && owed >= -100000, `balance ${owed / 1e6}`);
  const refused = await (await job(a.key)).json();
  check("further jobs refused at the limit", refused.error?.code === "insufficient_balance");
  const { data: pot } = await db.rpc("fuel_pot_used");
  check("pot counts the trial + credit in use", Number(pot) >= 1000000 - owed && Number(pot) <= 1000000 - owed + 1, `pot used ${pot}`);
  const { data: acc1 } = await db.from("accounts").select("debt_since").eq("wallet", a.wallet).single();
  check("debt start recorded", !!acc1.debt_since);

  // Repay with a top-up: the debt is cleared first.
  await deposit(a.wallet, 1);
  const { data: acc2 } = await db.from("accounts").select("balance_micro, debt_since").eq("wallet", a.wallet).single();
  check("top-up repays the debt first", Number(acc2.balance_micro) === 1_000_000 + owed && acc2.debt_since === null, `balance ${acc2.balance_micro / 1e6}`);

  // Overdue: push into debt again, backdate it 31 days, jobs freeze; a top-up unfreezes.
  await db.from("accounts").update({ balance_micro: -50000 }).eq("wallet", a.wallet);
  await db.from("accounts").update({ debt_since: new Date(Date.now() - 31 * 86_400_000).toISOString() }).eq("wallet", a.wallet);
  const frozen = await (await job(a.key)).json();
  check("overdue debt freezes jobs", frozen.error?.code === "credit_overdue");
  f = await req("/v1/faucet", { key: a.key }).then((r) => r.json());
  check("faucet status shows overdue", f.credit.overdue === true);
  await deposit(a.wallet, 0.5);
  check("top-up clears it and jobs run again", (await job(a.key)).ok);
  const me = await acct(a.key);
  check("account view includes credit", typeof me.faucet?.credit?.limit_usd === "number");

  // Pot cap: shrink the pot so a second trial doesn't fit.
  const b = await newWallet();
  wallets.push(b.wallet);
  const { data: used } = await db.rpc("fuel_pot_used");
  await db.from("faucet_config").update({ pot_micro: Number(used) + 100000 }).eq("id", 1);
  check("trial refused when the pot is used up", (await db.rpc("fuel_faucet_trial", { p_wallet: b.wallet })).data === "pot_empty");
  await db.from("faucet_config").update({ enabled: false }).eq("id", 1);
  check("faucet switch turns credit off", (await db.rpc("fuel_credit_limit", { p_wallet: a.wallet })).data === 0);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  await db.from("faucet_config").update({ enabled: cfg0.enabled, pot_micro: cfg0.pot_micro, max_per_agent_micro: cfg0.max_per_agent_micro, trial_micro: cfg0.trial_micro, credit_share: cfg0.credit_share, due_days: cfg0.due_days }).eq("id", 1);
  for (const t of ["faucet_trials", "ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().in("wallet", wallets);
  await db.from("accounts").delete().in("wallet", wallets);
  await db.from("provider_models").delete().eq("model", MODEL);
  const { data: c } = await db.from("faucet_config").select("pot_micro, enabled").eq("id", 1).single();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed", `(cleaned up; faucet config restored: pot $${c.pot_micro / 1e6}, enabled ${c.enabled})`);
  process.exit(failures ? 1 : 0);
}
