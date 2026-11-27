// Phase 2 check: agent registration, public pages, community credit, leaderboards, and the
// "Fuel this agent" Solana Action (the transaction is simulated on mainnet, never sent).
// Run against a dev server: node --env-file=.env.local scripts/agents-test.mjs http://localhost:3000
// Uses throwaway wallets and deletes everything it creates.
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
  fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function newWallet() {
  const sk = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const k = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  return { wallet, key: k.api_key };
}

const NAME = `test-agent-${Date.now().toString(36)}`;
const wallets = [];
const sigs = [];
try {
  const agent = await newWallet();
  const fan1 = await newWallet();
  const fan2 = await newWallet();
  wallets.push(agent.wallet, fan1.wallet, fan2.wallet);

  // Registration rules
  const bad = await req("/v1/agents", { key: agent.key, method: "POST", body: { name: "-bad-", display_name: "x" } });
  check("invalid name rejected", bad.status === 400);
  const reserved = await req("/v1/agents", { key: agent.key, method: "POST", body: { name: "dashboard", display_name: "x" } });
  check("reserved name rejected", reserved.status === 400);
  check("registration needs a key", (await req("/v1/agents", { method: "POST", body: { name: NAME, display_name: "x" } })).status === 401);
  const reg = await req("/v1/agents", {
    key: agent.key,
    method: "POST",
    body: { name: NAME, display_name: "Test Agent", description: "Summarises things.", x_handle: "@fuel_test", website: "https://example.com" },
  });
  const regj = await reg.json();
  check("agent registered", reg.status === 201 && regj.name === NAME && regj.x_handle === "fuel_test", JSON.stringify({ status: reg.status, err: regj.error?.message }));
  const dup = await req("/v1/agents", { key: fan1.key, method: "POST", body: { name: NAME, display_name: "copycat" } });
  check("name is unique", dup.status === 409);
  const rename = await req("/v1/agents", { key: agent.key, method: "POST", body: { name: NAME + "-x" } });
  check("name can't change", rename.status === 400);
  const upd = await (await req("/v1/agents", { key: agent.key, method: "POST", body: { description: "Updated." } })).json();
  check("profile update", upd.description === "Updated." && upd.display_name === "Test Agent");

  // Community top-ups (via the DB function: the on-chain path is covered by the Action simulation)
  const credit = async (fan, usd, i) => {
    const sig = `agents-test-${NAME}-${i}`;
    sigs.push(sig);
    await db.rpc("fuel_credit_deposit", { p_signature: sig, p_wallet: agent.wallet, p_asset: "USDC", p_amount_raw: usd * 1e6, p_usd_price: null, p_credit: usd * 1e6, p_slot: 0, p_supporter: fan.wallet, p_via: "memo" });
  };
  await credit(fan1, 5, 1);
  await credit(fan1, 2, 2);
  await credit(fan2, 3, 3);
  const pub = await (await req(`/v1/agents/${NAME}`)).json();
  check(
    "public profile: totals + supporters",
    pub.balance_usd === 10 && pub.community_fuel_usd === 10 && pub.supporters === 2 && pub.top_supporters[0].wallet === fan1.wallet && pub.top_supporters[0].total_usd === 7,
    JSON.stringify({ balance: pub.balance_usd, community: pub.community_fuel_usd, supporters: pub.supporters }),
  );
  check("public profile has no job details", !("jobs" in pub) && !JSON.stringify(pub).includes("prompt"));
  const agentAcct = await (await req("/v1/account", { key: agent.key })).json();
  check("agent's own balance credited", agentAcct.balance_usd === 10 && agentAcct.agent?.name === NAME);
  const fanHist = await (await req("/v1/topups", { key: fan1.key })).json();
  check("supporter sees their community top-ups", fanHist.data.length === 2 && fanHist.data.every((d) => d.supporter_wallet === fan1.wallet && d.wallet === agent.wallet));
  const fanAcct = await (await req("/v1/account", { key: fan1.key })).json();
  check("supporter's own balance untouched", fanAcct.balance_usd === 0);

  const lb = await (await req("/v1/leaderboard")).json();
  check("leaderboard lists agent and fuellers", lb.agents.some((a) => a.name === NAME) && lb.fuellers.some((f) => f.wallet === fan1.wallet));
  check("unknown agent → 404", (await req("/v1/agents/no-such-agent-here")).status === 404);

  // Pages render
  const page = await fetch(`${BASE}/agent/${NAME}`);
  const html = await page.text();
  check("agent page renders", page.status === 200 && html.includes("Test Agent") && html.includes("Top fuellers"));
  check("leaderboard page renders", (await fetch(`${BASE}/leaderboard`)).status === 200);
  // Streaming pages can't change the status after headers go out; Next marks the not-found page noindex instead.
  check("unknown agent page shows not-found (noindex)", (await (await fetch(`${BASE}/agent/no-such-agent-here`)).text()).includes('content="noindex"'));

  // Solana Action
  const aj = await fetch(`${BASE}/actions.json`);
  check("actions.json served with CORS", aj.ok && aj.headers.get("access-control-allow-origin") === "*" && (await aj.json()).rules.length >= 1);
  const meta = await fetch(`${BASE}/api/actions/fuel/${NAME}`);
  const metaj = await meta.json();
  check("action metadata", meta.ok && metaj.type === "action" && metaj.links.actions.length === 5 && meta.headers.get("x-action-version"), metaj.title);

  // Simulate the built transaction for a real mainnet wallet holding USDC (no signature, nothing sent).
  const RPC = process.env.SOLANA_RPC_URL;
  const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  // A normal (system-owned) wallet that recently moved USDC and still holds >= 2 USDC and some SOL.
  let payer = null;
  const recent = await rpc("getSignaturesForAddress", ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", { limit: 40 }]);
  for (const r of recent.result ?? []) {
    if (payer || r.err) continue;
    const tx = await rpc("getTransaction", [r.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
    for (const b of tx.result?.meta?.postTokenBalances ?? []) {
      if (b.mint !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" || Number(b.uiTokenAmount.uiAmount) < 2 || !b.owner) continue;
      const o = await rpc("getAccountInfo", [b.owner, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      if (o.result?.value?.owner === "11111111111111111111111111111111" && o.result.value.lamports > 2e7) {
        payer = b.owner;
        break;
      }
    }
  }
  check("found a real USDC holder to simulate with", !!payer);
  const built = await (await req(`/api/actions/fuel/${NAME}?asset=USDC&amount=1`, { method: "POST", body: { account: payer } })).json();
  check("action builds a transaction", typeof built.transaction === "string" && built.links?.next?.href?.endsWith("/confirm"), built.message);
  // Ask the simulation for Fuel's USDC account afterwards: it must hold exactly 1 USDC more.
  const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");
  const { address } = await import("@solana/kit");
  const [depositAta] = await findAssociatedTokenPda({ owner: address(process.env.FUEL_DEPOSIT_WALLET), mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const before = await rpc("getTokenAccountBalance", [depositAta]);
  const beforeRaw = BigInt(before.result?.value?.amount ?? "0");
  const sim = await rpc("simulateTransaction", [built.transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "jsonParsed", addresses: [depositAta] } }]);
  const logs = sim.result?.value?.logs ?? [];
  const afterRaw = BigInt(sim.result?.value?.accounts?.[0]?.data?.parsed?.info?.tokenAmount?.amount ?? "0");
  check("simulated: succeeds on mainnet", sim.result && sim.result.value.err === null, JSON.stringify(sim.result?.value?.err ?? sim.error ?? null));
  check("simulated: Fuel's USDC account +1.000000 USDC", afterRaw - beforeRaw === 1_000_000n, `${beforeRaw} -> ${afterRaw}`);
  check("simulated: memo names the agent", logs.some((l) => l.includes(`fuel:${NAME}`)));
  const solBuilt = await (await req(`/api/actions/fuel/${NAME}?asset=SOL&amount=0.01`, { method: "POST", body: { account: payer } })).json();
  const solSim = await rpc("simulateTransaction", [solBuilt.transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
  check("simulated: SOL top-up succeeds with memo", solSim.result?.value?.err === null && solSim.result.value.logs.some((l) => l.includes(`fuel:${NAME}`)));
  const poor = await req(`/api/actions/fuel/${NAME}?asset=USDC&amount=1`, { method: "POST", body: { account: agent.wallet } });
  check("wallet without USDC gets a clear error", poor.status === 400 && (await poor.json()).message.includes("doesn't hold"));
  check("amount limits enforced", (await req(`/api/actions/fuel/${NAME}?asset=USDC&amount=0.01`, { method: "POST", body: { account: payer } })).status === 400);
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  await db.from("ledger_entries").delete().in("wallet", wallets);
  await db.from("deposits").delete().in("signature", sigs);
  await db.from("agents").delete().in("wallet", wallets);
  for (const t of ["jobs", "api_keys", "auth_nonces"]) await db.from(t).delete().in("wallet", wallets);
  await db.from("accounts").delete().in("wallet", wallets);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
