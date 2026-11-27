// Phase 3 check: linking fee wallets (self-fuelling), the deposit scanner, and attribution.
// Part "link" runs against any dev server. Part "attribution" needs a dev server whose
// FUEL_DEPOSIT_WALLET is the recipient of a real transfer (see README); pass its signature + sender.
//   node --env-file=.env.local scripts/selffuel-test.mjs http://localhost:3000 link
//   node --env-file=.env.local scripts/selffuel-test.mjs http://localhost:3000 attribution <signature> <sender>
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const [BASE = "http://localhost:3000", PART = "link", SIG, SENDER] = process.argv.slice(2);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body, headers = {} } = {}) =>
  fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const keypair = () => {
  const sk = ed25519.utils.randomSecretKey();
  return { sk, wallet: bs58.encode(ed25519.getPublicKey(sk)) };
};
const sign = (sk, msg) => bs58.encode(ed25519.sign(new TextEncoder().encode(msg), sk));
async function signIn(kp) {
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet: kp.wallet } })).json();
  return (await (await req("/v1/auth/keys", { method: "POST", body: { wallet: kp.wallet, nonce: n.nonce, signature: sign(kp.sk, n.message) } })).json()).api_key;
}
async function newAgent(tag) {
  const kp = keypair();
  const key = await signIn(kp);
  const name = `sf-${tag}-${Date.now().toString(36)}`;
  await req("/v1/agents", { key, method: "POST", body: { name, display_name: `Self ${tag}` } });
  return { ...kp, key, name };
}

const wallets = [];
const sigs = [];
try {
  if (PART === "link") {
    const a = await newAgent("a");
    const b = await newAgent("b");
    const fee = keypair();
    wallets.push(a.wallet, b.wallet, fee.wallet);

    const notAgent = keypair();
    wallets.push(notAgent.wallet);
    const notAgentKey = await signIn(notAgent);
    check("non-agent can't link", (await req("/v1/agents/fee-sources/nonce", { key: notAgentKey, method: "POST", body: { source: fee.wallet } })).status === 400);
    check("own wallet can't be a source", (await req("/v1/agents/fee-sources/nonce", { key: a.key, method: "POST", body: { source: a.wallet } })).status === 400);

    const n = await (await req("/v1/agents/fee-sources/nonce", { key: a.key, method: "POST", body: { source: fee.wallet } })).json();
    check("link message names the agent", n.message.includes(`Agent: ${a.name}`) && n.message.includes(`Agent wallet: ${a.wallet}`));
    const wrongSigner = keypair();
    const bad = await req("/v1/agents/fee-sources", { key: a.key, method: "POST", body: { source: fee.wallet, nonce: n.nonce, signature: sign(wrongSigner.sk, n.message) } });
    check("signature by another wallet refused", bad.status === 401);

    const n2 = await (await req("/v1/agents/fee-sources/nonce", { key: a.key, method: "POST", body: { source: fee.wallet } })).json();
    const stolen = await req("/v1/agents/fee-sources", { key: b.key, method: "POST", body: { source: fee.wallet, nonce: n2.nonce, signature: sign(fee.sk, n2.message) } });
    check("a signature issued for agent A can't link to agent B", stolen.status === 403);

    const n3 = await (await req("/v1/agents/fee-sources/nonce", { key: a.key, method: "POST", body: { source: fee.wallet } })).json();
    const ok = await req("/v1/agents/fee-sources", { key: a.key, method: "POST", body: { source: fee.wallet, nonce: n3.nonce, signature: sign(fee.sk, n3.message), label: "Meteora fees" } });
    const okj = await ok.json();
    check("fee wallet linked", ok.status === 201 && okj.data[0]?.wallet === fee.wallet && okj.data[0]?.label === "Meteora fees");
    check("nonce can't be reused", (await req("/v1/agents/fee-sources", { key: a.key, method: "POST", body: { source: fee.wallet, nonce: n3.nonce, signature: sign(fee.sk, n3.message) } })).status === 401);

    const n4 = await (await req("/v1/agents/fee-sources/nonce", { key: b.key, method: "POST", body: { source: fee.wallet } })).json();
    const taken = await req("/v1/agents/fee-sources", { key: b.key, method: "POST", body: { source: fee.wallet, nonce: n4.nonce, signature: sign(fee.sk, n4.message) } });
    check("a source feeds one agent only", taken.status === 409);

    check("other agents can't unlink it", (await req(`/v1/agents/fee-sources/${fee.wallet}`, { key: b.key, method: "DELETE" })).status === 404);
    const un = await (await req(`/v1/agents/fee-sources/${fee.wallet}`, { key: a.key, method: "DELETE" })).json();
    check("unlink", Array.isArray(un.data) && un.data.length === 0);

    // Scanner against the real deposit address (credits nothing that isn't a real deposit)
    const cron = await req("/api/cron/ring-scan", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    const cj = await cron.json();
    check("scanner runs over SOL + USDC deposit addresses", cron.status === 200 && Array.isArray(cj.deposits) && cj.deposits.length === 2, JSON.stringify(cj.deposits));
    const { data: cursors } = await db.from("deposit_scan_state").select("address, last_signature");
    check("scanner saved its cursors", (cursors ?? []).length >= 1, JSON.stringify((cursors ?? []).map((c) => ({ address: c.address.slice(0, 6), has_cursor: !!c.last_signature }))));
    const cron2 = await (await req("/api/cron/ring-scan", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })).json();
    check("second scan finds nothing new", cron2.deposits.every((d) => d.new === 0), JSON.stringify(cron2.deposits));
  } else {
    // Attribution: link the real sender as a fee source (directly, it can't sign for us), then confirm.
    const a = await newAgent("attr");
    wallets.push(a.wallet, SENDER);
    sigs.push(SIG);
    await db.from("agent_fee_sources").insert({ source_wallet: SENDER, agent_wallet: a.wallet, label: "test" });
    const r = await req("/v1/topups", { method: "POST", body: { signature: SIG } });
    const j = await r.json();
    check("real transfer from a linked fee wallet credits the agent", r.status === 201 && j.wallet === a.wallet && j.via === "fee_source" && j.supporter_wallet === SENDER, JSON.stringify({ status: r.status, via: j.via, credited_usd: j.credited_usd, err: j.error?.code }));
    const pub = await (await req(`/v1/agents/${a.name}`)).json();
    check("counted as self-fuel, not community", pub.self_fuel_usd === j.credited_usd && pub.community_fuel_usd === 0 && pub.supporters === 0, JSON.stringify({ self: pub.self_fuel_usd, community: pub.community_fuel_usd }));
    const lb = await (await req("/v1/leaderboard")).json();
    check("fee wallet is not on the fuellers leaderboard", !lb.fuellers.some((f) => f.wallet === SENDER));
  }
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  await db.from("agent_fee_sources").delete().in("source_wallet", wallets);
  await db.from("ledger_entries").delete().in("wallet", wallets);
  if (sigs.length) await db.from("deposits").delete().in("signature", sigs);
  await db.from("deposits").delete().in("wallet", wallets);
  await db.from("agents").delete().in("wallet", wallets);
  for (const t of ["jobs", "api_keys", "auth_nonces"]) await db.from(t).delete().in("wallet", wallets);
  await db.from("accounts").delete().in("wallet", wallets);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
