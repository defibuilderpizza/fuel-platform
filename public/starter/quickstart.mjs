// Fuel starter kit (Node 18+): give an agent its own wallet, sign in, check its balance and run a job.
//
//   npm i @noble/curves bs58 openai
//   node quickstart.mjs
//
// Env (all optional):
//   FUEL_BASE_URL   default https://fuelai.cloud
//   FUEL_KEYPAIR    path to a Solana keypair JSON (64-number array). Default: ./fuel-agent-keypair.json,
//                   created on first run. Fund this wallet's Fuel balance by sending USDC or SOL from it.
//   FUEL_MODEL      default openai/gpt-oss-120b
//
// The API key is cached in ./.fuel-api-key. Signing in never sends a transaction or costs anything.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import OpenAI from "openai";

const BASE = (process.env.FUEL_BASE_URL ?? "https://fuelai.cloud").replace(/\/+$/, "");
const KEYPAIR = process.env.FUEL_KEYPAIR ?? "./fuel-agent-keypair.json";
const MODEL = process.env.FUEL_MODEL ?? "openai/gpt-oss-120b";
const KEY_FILE = "./.fuel-api-key";

async function call(path, { key, method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// 1. The agent's wallet (Solana keypair file: 32-byte secret + 32-byte public key)
function loadOrCreateKeypair() {
  if (existsSync(KEYPAIR)) {
    const bytes = Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8")));
    return { secret: bytes.slice(0, 32), wallet: bs58.encode(bytes.slice(32, 64)) };
  }
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  writeFileSync(KEYPAIR, JSON.stringify([...secret, ...pub]), { mode: 0o600 });
  console.log(`Created a new wallet for this agent: ${KEYPAIR} (keep it safe; it holds the agent's identity)`);
  return { secret, wallet: bs58.encode(pub) };
}

// 2. Sign in: sign a one-time message, get an API key
async function signIn({ secret, wallet }) {
  if (existsSync(KEY_FILE)) {
    const key = readFileSync(KEY_FILE, "utf8").trim();
    if ((await call("/v1/account", { key })).ok) return key;
  }
  const n = await call("/v1/auth/nonce", { method: "POST", body: { wallet } });
  if (!n.ok) throw new Error(n.json?.error?.message ?? "Could not start sign-in");
  const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(n.json.message), secret));
  const k = await call("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.json.nonce, signature, label: "starter-kit" } });
  if (!k.ok) throw new Error(k.json?.error?.message ?? "Sign-in failed");
  writeFileSync(KEY_FILE, k.json.api_key, { mode: 0o600 });
  return k.json.api_key;
}

const kp = loadOrCreateKeypair();
console.log(`Agent wallet: ${kp.wallet}`);
const key = await signIn(kp);
console.log("Signed in to Fuel.");

// 3. Balance: claim the free trial credits if empty (any wallet, once)
let acct = (await call("/v1/account", { key })).json;
if (!(acct.available_usd > 0)) {
  const t = await call("/v1/faucet/claim", { key, method: "POST" });
  if (t.ok) {
    console.log("Claimed the free trial credits.");
    acct = (await call("/v1/account", { key })).json;
  } else {
    console.log(`\nNo balance yet (${t.json?.error?.message ?? "trial not available"}).`);
    console.log(`Top up: send USDC or SOL FROM ${kp.wallet} TO ${acct.deposit.address}.`);
    console.log("Fuel spots it within minutes (or POST /v1/topups with the signature). Then run this again.");
    process.exit(0);
  }
}
console.log(`Balance: $${acct.available_usd.toFixed(6)} available`);

// 4. Run a job with the standard OpenAI SDK, pointed at Fuel
const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: key });
const r = await client.chat.completions.create({
  model: MODEL,
  max_tokens: 200,
  messages: [{ role: "user", content: "In one sentence: what is a compute market for AI agents?" }],
});
console.log(`\n${MODEL}: ${r.choices[0].message.content}`);
console.log("Receipt:", r.fuel);
