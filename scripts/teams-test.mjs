// Team accounts + market rates check. Needs a dev server with FUEL_ENABLE_MOCK=1:
//   node --env-file=.env.local scripts/teams-test.mjs http://localhost:3000
// Throwaway wallets; deletes everything it creates.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const MODEL = "fuel-test/team-mock";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (p, o) => (await req(p, o)).json();
async function newWallet() {
  const sk = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await json("/v1/auth/nonce", { method: "POST", body: { wallet } });
  const k = await json("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } });
  return { wallet, key: k.api_key };
}
let dep = 0;
const deposit = (wallet, usd) => db.rpc("fuel_credit_deposit", { p_signature: `teams-test-${wallet}-${dep++}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: usd * 1e6, p_usd_price: null, p_credit: usd * 1e6, p_slot: 0 });

const wallets = [];
const teamIds = [];
try {
  await db.from("provider_models").upsert([{ model: MODEL, kind: "chat", provider: "mock", provider_model_id: "ok", input_per_mtok: 100, output_per_mtok: 100 }], { onConflict: "model,provider" });
  const [owner, admin, member, agent1, agent2, outsider] = await Promise.all(Array.from({ length: 6 }, newWallet));
  wallets.push(owner.wallet, admin.wallet, member.wallet, agent1.wallet, agent2.wallet, outsider.wallet);

  const t = await json("/v1/teams", { key: owner.key, method: "POST", body: { name: "Test Ops" } });
  teamIds.push(t.id);
  check("team created, creator is owner", t.role === "owner" && !!t.id);

  const inv = async (role, key = owner.key) => req(`/v1/teams/${t.id}/invites`, { key, method: "POST", body: { role } });
  const code1 = (await (await inv("agent")).json()).code;
  check("agent joins with its own key", (await req("/v1/teams/join", { key: agent1.key, method: "POST", body: { code: code1, label: "research-bot" } })).status === 201);
  check("an invite code works once", (await req("/v1/teams/join", { key: agent2.key, method: "POST", body: { code: code1 } })).status === 404);
  const code2 = (await (await inv("agent")).json()).code;
  await req("/v1/teams/join", { key: agent2.key, method: "POST", body: { code: code2, label: "trader" } });

  check("agents can't see the team view", (await req(`/v1/teams/${t.id}`, { key: agent1.key })).status === 404);
  check("outsiders can't see the team", (await req(`/v1/teams/${t.id}`, { key: outsider.key })).status === 404);

  const mcode = (await (await inv("member")).json()).code;
  await req("/v1/teams/join", { key: member.key, method: "POST", body: { code: mcode } });
  check("members can view", (await req(`/v1/teams/${t.id}`, { key: member.key })).status === 200);
  check("members can't invite", (await inv("agent", member.key)).status === 403);
  check("members can't change limits", (await req(`/v1/teams/${t.id}/agents/${agent1.wallet}`, { key: member.key, method: "PATCH", body: { daily_usd: 1 } })).status === 403);

  const acode = (await (await inv("admin")).json()).code;
  await req("/v1/teams/join", { key: admin.key, method: "POST", body: { code: acode } });
  check("admins can't invite admins", (await inv("admin", admin.key)).status === 403);
  check("admins set agent limits", (await req(`/v1/teams/${t.id}/agents/${agent1.wallet}`, { key: admin.key, method: "PATCH", body: { daily_usd: 3, per_job_usd: 0.5 } })).status === 200);
  const a1 = await json("/v1/account", { key: agent1.key });
  check("limits apply to the agent", a1.limits.daily_usd === 3 && a1.limits.per_job_usd === 0.5);
  check("can't manage a wallet that isn't a team agent", (await req(`/v1/teams/${t.id}/agents/${outsider.wallet}`, { key: owner.key, method: "PATCH", body: { daily_usd: 1 } })).status === 404);

  // Funding from the owner's own balance
  await deposit(owner.wallet, 5);
  check("owner funds an agent", (await req(`/v1/teams/${t.id}/agents/${agent1.wallet}/fund`, { key: owner.key, method: "POST", body: { usd: 2 } })).status === 200);
  check("can't fund beyond own balance", (await req(`/v1/teams/${t.id}/agents/${agent2.wallet}/fund`, { key: owner.key, method: "POST", body: { usd: 10 } })).status === 402);
  await req(`/v1/teams/${t.id}/agents/${agent2.wallet}/fund`, { key: owner.key, method: "POST", body: { usd: 1 } });
  const ob = (await json("/v1/account", { key: owner.key })).balance_usd;
  const ab1 = (await json("/v1/account", { key: agent1.key })).balance_usd;
  check("balances moved exactly", ob === 2 && ab1 === 2, JSON.stringify({ owner: ob, agent1: ab1 }));

  // Agents run jobs; the team sees combined spend and receipts
  for (let i = 0; i < 2; i++) await req("/v1/chat/completions", { key: agent1.key, method: "POST", body: { model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "hi" }] } });
  await req("/v1/chat/completions", { key: agent2.key, method: "POST", body: { model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "hi" }] } });
  const ov = await json(`/v1/teams/${t.id}`, { key: owner.key });
  const spent = ov.agents.reduce((s, a) => s + a.spent_today_usd, 0);
  check("team view: 2 agents, combined totals", ov.totals.agents === 2 && Math.abs(ov.totals.spent_today_usd - spent) < 1e-9 && ov.totals.jobs_30d === 3, JSON.stringify(ov.totals));
  check("team view: receipts from all agents", ov.receipts.length === 3 && new Set(ov.receipts.map((r) => r.agent)).size === 2);
  check("labels shown", ov.agents.some((a) => a.label === "research-bot"));
  check("people listed without agents", ov.people.length === 3 && ov.people.every((p) => p.role !== "agent"));

  // One team per agent; removal; the owner stays
  const t2 = await json("/v1/teams", { key: outsider.key, method: "POST", body: { name: "Other" } });
  teamIds.push(t2.id);
  const c3 = (await json(`/v1/teams/${t2.id}/invites`, { key: outsider.key, method: "POST", body: { role: "agent" } })).code;
  check("an agent belongs to one team at a time", (await req("/v1/teams/join", { key: agent1.key, method: "POST", body: { code: c3 } })).status === 409);
  check("owner can't be removed", (await req(`/v1/teams/${t.id}/members/${owner.wallet}`, { key: admin.key, method: "DELETE" })).status === 400);
  check("admin removes an agent", (await req(`/v1/teams/${t.id}/members/${agent1.wallet}`, { key: admin.key, method: "DELETE" })).status === 200);
  check("removed agent keeps its balance", (await json("/v1/account", { key: agent1.key })).balance_usd > 0);
  check("removed agent can join another team", (await req("/v1/teams/join", { key: agent1.key, method: "POST", body: { code: c3 } })).status === 201);
  check("members can leave", (await req(`/v1/teams/${t.id}/members/${member.wallet}`, { key: member.key, method: "DELETE" })).status === 200);

  // Market rates
  const mk = await json("/v1/market");
  const r = mk.data.find((x) => x.providers > 0 && x.kind === "chat");
  check("market: rates with price to beat and suggestion", !!r && r.to_win.in < r.low.in && r.agent_price.in > r.low.in, JSON.stringify(r && { low: r.low, to_win: r.to_win, agent: r.agent_price }));
  check("market excludes mock providers", !mk.data.some((x) => x.model === MODEL));
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  if (teamIds.length) await db.from("teams").delete().in("id", teamIds);
  for (const tb of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(tb).delete().in("wallet", wallets);
  await db.from("accounts").delete().in("wallet", wallets);
  await db.from("provider_models").delete().eq("model", MODEL);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
