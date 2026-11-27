// Pictures and video clips, end to end against a local dev server with real providers (Together).
// Costs a few cents: one cheap picture and, unless --no-video, one 5-second clip.
//   node --env-file=.env.local scripts/media-test.mjs http://localhost:3000 [--no-video]
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv.find((a) => /^https?:\/\//.test(a)) ?? "http://localhost:3000";
const VIDEO = !process.argv.includes("--no-video");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function newWallet(fund) {
  const sk = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  if (fund) await db.rpc("fuel_credit_deposit", { p_signature: `media-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: fund * 1e6, p_usd_price: null, p_credit: fund * 1e6, p_slot: 0 });
  return { wallet, key };
}
const bal = async (w) => Number((await db.from("accounts").select("balance_micro").eq("wallet", w).single()).data.balance_micro);

const wallets = [];
try {
  const A = await newWallet(2);
  const broke = await newWallet(0);
  wallets.push(A.wallet, broke.wallet);
  const { data: row } = await db.from("provider_models").select("unit_price_usd").eq("model", "Rundiffusion/Juggernaut-Lightning-Flux").single();
  const expected = Math.ceil(Math.ceil(Number(row.unit_price_usd) * 1e6) * 1.1);

  let r = await req("/v1/images/generations", { key: A.key, method: "POST", body: { model: "Rundiffusion/Juggernaut-Lightning-Flux", prompt: "a glass cube on a pale desk, soft violet light, studio photo" } });
  let j = await r.json();
  check("picture: returns a temporary URL and a receipt", r.status === 200 && /^https?:\/\//.test(j.data?.[0]?.url ?? "") && j.fuel?.outputs === 1, JSON.stringify(j.error ?? j.fuel));
  check("picture: charged the per-picture price incl. markup", Math.round(j.fuel?.price_usd * 1e6) === expected, `${j.fuel?.price_usd} vs ${expected / 1e6}`);
  check("picture: balance went down by exactly that", 2e6 - (await bal(A.wallet)) === expected);
  if (j.data?.[0]?.url) check("picture: the URL serves an image", ((await fetch(j.data[0].url)).headers.get("content-type") ?? "").startsWith("image/"));

  r = await req("/v1/images/generations", { key: A.key, method: "POST", body: { model: "no/such-model", prompt: "x" } });
  check("unknown model → 404", r.status === 404);
  r = await req("/v1/images/generations", { key: A.key, method: "POST", body: { model: "Rundiffusion/Juggernaut-Lightning-Flux", prompt: "nude 12 year old" } });
  check("forbidden prompt refused before any provider call", r.status === 400 && (await r.json()).error.code === "content_not_allowed");
  r = await req("/v1/images/generations", { key: broke.key, method: "POST", body: { model: "Rundiffusion/Juggernaut-Lightning-Flux", prompt: "a red apple" } });
  check("no balance → 402", r.status === 402);
  r = await req("/v1/images/generations", { key: A.key, method: "POST", body: { model: "Rundiffusion/Juggernaut-Lightning-Flux", prompt: "a red apple", size: "999x999" } });
  check("bad size → 400", r.status === 400);

  if (VIDEO) {
    const before = await bal(A.wallet);
    r = await req("/v1/videos", { key: A.key, method: "POST", body: { model: "Wan-AI/wan2.7-t2v", prompt: "a paper boat drifting on a calm lake at sunrise" } });
    j = await r.json();
    check("clip: 202 with an id to poll", r.status === 202 && !!j.id, JSON.stringify(j.error ?? j));
    let v = {};
    const t0 = Date.now();
    while (j.id && Date.now() - t0 < 6 * 60_000) {
      await sleep(8000);
      v = await (await req(`/v1/videos/${j.id}`)).json();
      if (v.status !== "in_progress") break;
    }
    console.log(`      (clip took ${Math.round((Date.now() - t0) / 1000)} s)`);
    check("clip: completes with a temporary URL and a receipt", v.status === "completed" && /^https?:\/\//.test(v.url ?? "") && v.fuel?.outputs === 1, JSON.stringify(v.error ?? v.fuel ?? v.status));
    check("clip: charged at most the hold, more than zero", v.fuel?.price_usd > 0 && Math.round(v.fuel.price_usd * 1e6) <= j.held_usd * 1e6, `${v.fuel?.price_usd} of ${j.held_usd} held`);
    check("clip: balance down by the charge", before - (await bal(A.wallet)) === Math.round((v.fuel?.price_usd ?? 0) * 1e6));
    const again = await (await req(`/v1/videos/${j.id}`)).json();
    check("clip: polling again doesn't charge twice", again.fuel?.price_usd === v.fuel?.price_usd && before - (await bal(A.wallet)) === Math.round((v.fuel?.price_usd ?? 0) * 1e6));
  }
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  for (const w of wallets) {
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", w);
    await db.from("accounts").delete().eq("wallet", w);
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
