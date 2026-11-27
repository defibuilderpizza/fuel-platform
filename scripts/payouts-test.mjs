// End-to-end check of earnings payouts (needs migration 0021).
//   node --env-file=.env.local scripts/payouts-test.mjs [baseUrl]
// Creates a throwaway wallet with $1 of deposits and $10 of seller earnings, then checks:
// only earnings can be withdrawn, the minimum, one open payout at a time, cancel and reject
// refunds, admin approval returns a Solana Pay link, and a fake transfer can't mark it paid.
// Deletes everything it created. Sends no money.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomUUID } from "node:crypto";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ADMIN = process.env.FUEL_ADMIN_TOKEN;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failures++; };
const api = (path, { key, admin, body, ...init } = {}) =>
  fetch(BASE + path, {
    ...init,
    method: body ? "POST" : init.method ?? "GET",
    body: body ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(admin ? { "x-admin-token": ADMIN } : {}) },
  });
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

const secret = ed25519.utils.randomSecretKey();
const wallet = bs58.encode(ed25519.getPublicKey(secret));
const depositSig = "payouts-test-" + wallet;

try {
  const n = await (await api("/v1/auth/nonce", { body: { wallet } })).json();
  const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), secret));
  const { api_key: key } = await (await api("/v1/auth/keys", { body: { wallet, nonce: n.nonce, signature, label: "payouts-test" } })).json();
  check("signed in", key?.startsWith("fuel_sk_"));

  // $1 deposit (not withdrawable) + $10 seller earnings (withdrawable).
  await db.rpc("fuel_credit_deposit", { p_signature: depositSig, p_wallet: wallet, p_asset: "USDC", p_amount_raw: 1_000_000, p_usd_price: null, p_credit: 1_000_000, p_slot: 0 });
  await db.rpc("fuel_seller_pay", { p_wallet: wallet, p_micro: 10_000_000, p_job: randomUUID() });

  let s = await json(await api("/v1/payouts", { key }));
  check("summary: earned $10, can withdraw $10 (not the $1 deposit)", s.body.earned_total_usd === 10 && s.body.available_usd === 10, JSON.stringify(s.body));

  let r = await json(await api("/v1/payouts", { key, body: { amount_usd: 10.5 } }));
  check("can't withdraw more than earnings", r.status === 400 && r.body.error?.code === "insufficient_earnings", JSON.stringify(r.body.error));
  r = await json(await api("/v1/payouts", { key, body: { amount_usd: 1 } }));
  check("below minimum refused", r.status === 400 && r.body.error?.code === "below_minimum");

  r = await json(await api("/v1/payouts", { key, body: { amount_usd: 6 } }));
  check("payout requested", r.status === 201 && r.body.status === "requested");
  const first = r.body.id;
  let acct = (await json(await api("/v1/account", { key }))).body;
  check("balance debited at once ($11 → $5)", acct.balance_usd === 5, JSON.stringify({ balance: acct.balance_usd }));
  r = await json(await api("/v1/payouts", { key, body: { amount_usd: 5 } }));
  check("only one open payout", r.status === 409);

  r = await json(await api(`/v1/payouts/${first}/cancel`, { key, method: "POST" }));
  check("owner can cancel before approval", r.status === 200 && r.body.status === "cancelled");
  acct = (await json(await api("/v1/account", { key }))).body;
  check("cancel refunds ($11)", acct.balance_usd === 11);

  r = await json(await api("/v1/payouts", { key, body: { amount_usd: 7 } }));
  const second = r.body.id;
  r = await json(await api(`/v1/admin/payouts/${second}`, { body: { action: "approve" } }));
  check("approve needs the admin token", r.status === 401);
  r = await json(await api(`/v1/admin/payouts/${second}`, { admin: true, body: { action: "approve" } }));
  const link = r.body.pay_link ?? "";
  check(
    "approve returns a Solana Pay link (wallet, 7 USDC, reference)",
    r.status === 200 && link.startsWith(`solana:${wallet}?`) && link.includes("amount=7&") && link.includes("spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") && link.includes("reference="),
    link,
  );
  r = await json(await api(`/v1/payouts/${second}/cancel`, { key, method: "POST" }));
  check("owner can't cancel once approved", r.status === 409);
  r = await json(await api(`/v1/admin/payouts/${second}`, { admin: true, body: { action: "paid", signature: "notasignature" } }));
  check("bogus signature can't mark paid", r.status === 400);
  // A real mainnet transaction that sent nothing to this wallet: must be refused.
  const { data: anyTx } = await db.from("deposits").select("signature").not("signature", "like", "%-%").limit(1).maybeSingle();
  if (anyTx?.signature) {
    r = await json(await api(`/v1/admin/payouts/${second}`, { admin: true, body: { action: "paid", signature: anyTx.signature } }));
    check("unrelated real transaction can't mark paid", r.status === 400, r.body.error?.message);
  }
  const list = (await json(await api("/v1/admin/payouts", { admin: true }))).body;
  check("admin queue lists it with its pay link", list.open?.some((p) => p.id === second && p.pay_link));

  r = await json(await api(`/v1/admin/payouts/${second}`, { admin: true, body: { action: "reject", note: "test" } }));
  check("admin reject", r.status === 200);
  acct = (await json(await api("/v1/account", { key }))).body;
  check("reject refunds ($11)", acct.balance_usd === 11);
  s = (await json(await api("/v1/payouts", { key }))).body;
  check("history shows cancelled + rejected; still $10 withdrawable", s.payouts.length === 2 && s.available_usd === 10, JSON.stringify(s.payouts.map((p) => p.status)));

  const { data: led } = await db.from("ledger_entries").select("delta_micro").eq("wallet", wallet);
  const sum = (led ?? []).reduce((t, e) => t + Number(e.delta_micro), 0);
  check("ledger sum = balance", sum === 11_000_000, String(sum));
} finally {
  await db.from("payouts").delete().eq("wallet", wallet);
  for (const t of ["ledger_entries", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", wallet);
  await db.from("accounts").delete().eq("wallet", wallet);
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
