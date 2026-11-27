// End-to-end check of the laptop lane with two simulated laptops running the real model in Node.
//   node --env-file=.env.local scripts/lane-test.mjs [baseUrl]
// Creates three throwaway wallets (two workers, one customer with a fake $1 deposit), then checks
// embeddings and zero-shot classification: cross-checked results, the charge, worker pay, and
// input validation. Deletes everything it created.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { pipeline } from "@huggingface/transformers";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const MODEL = "fuel-lane/bge-small-en-v1.5";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failures++; };
const api = (path, key, body) =>
  fetch(BASE + path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) } });

// Same crypto as src/lib/lane-crypto.ts
const DOMAIN = new TextEncoder().encode("fuel/lane/v1");
const b64 = (u) => Buffer.from(u).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const shared = (sk, pk) => { const s = x25519.getSharedSecret(sk, unb64(pk)); const b = new Uint8Array(DOMAIN.length + s.length); b.set(DOMAIN); b.set(s, DOMAIN.length); return sha256(b); };
const seal = (k, v) => { const n = randomBytes(24); const ct = xchacha20poly1305(k, n).encrypt(new TextEncoder().encode(JSON.stringify(v))); const o = new Uint8Array(24 + ct.length); o.set(n); o.set(ct, 24); return b64(o); };
const open = (k, s) => { const r = unb64(s); return JSON.parse(new TextDecoder().decode(xchacha20poly1305(k, r.slice(0, 24)).decrypt(r.slice(24)))); };

async function signIn(label) {
  const secret = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(secret));
  const n = await (await api("/v1/auth/nonce", null, { wallet })).json();
  const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), secret));
  const k = await (await api("/v1/auth/keys", null, { wallet, nonce: n.nonce, signature, label })).json();
  return { wallet, key: k.api_key };
}

const wallets = [];
let stop = false;
try {
  console.log("loading model…");
  const embed = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
  const workers = [await signIn("lane-test-w1"), await signIn("lane-test-w2")];
  const customer = await signIn("lane-test-customer");
  wallets.push(...workers.map((w) => w.wallet), customer.wallet);
  await db.rpc("fuel_credit_deposit", { p_signature: "lane-test-" + customer.wallet, p_wallet: customer.wallet, p_asset: "USDC", p_amount_raw: 1_000_000, p_usd_price: null, p_credit: 1_000_000, p_slot: 0 });

  // Two laptops: check in, long-poll, embed, hand back sealed vectors.
  const loops = workers.map(async (w) => {
    const sk = x25519.utils.randomSecretKey();
    const c = await (await api("/v1/lane/checkin", w.key, { pubkey: b64(x25519.getPublicKey(sk)) })).json();
    w.session = c.session_id;
    while (!stop) {
      const r = await (await api("/v1/lane/next", w.key, { session_id: w.session })).json().catch(() => ({}));
      if (!r.task) continue;
      const key = shared(sk, r.task.server_pubkey);
      const { inputs } = open(key, r.task.ciphertext);
      const vectors = (await embed(inputs, { pooling: "cls", normalize: true })).tolist();
      await api("/v1/lane/result", w.key, { session_id: w.session, task_id: r.task.id, result: seal(key, { vectors }) });
    }
  });
  await new Promise((ok) => setTimeout(ok, 1500));

  const e = await api("/v1/embeddings", customer.key, { model: MODEL, input: ["hello world", "compute for agents"] });
  const ej = await e.json();
  check("lane embeddings: 2 vectors, cross-checked by 2 laptops", e.status === 200 && ej.data?.length === 2 && ej.data[0].embedding.length === 384 && ej.fuel?.verified_by === 2, JSON.stringify(ej.fuel ?? ej.error));

  const c = await api("/v1/classifications", customer.key, {
    input: ["Solana fees went down after the upgrade.", "Bake the banana bread for 50 minutes.", "The striker scored twice in the final."],
    labels: ["crypto", "cooking", "sports"],
  });
  const cj = await c.json();
  const picked = cj.data?.map((d) => d.label);
  check("classification picks crypto / cooking / sports", c.status === 200 && JSON.stringify(picked) === JSON.stringify(["crypto", "cooking", "sports"]), JSON.stringify(picked ?? cj.error));
  check("scores per text sum to ~1 and are ranked", cj.data?.every((d) => Math.abs(d.scores.reduce((t, s) => t + s.score, 0) - 1) < 0.01 && d.scores[0].similarity >= d.scores[1].similarity));
  check("classification receipt: charged, verified by 2", cj.fuel?.price_usd > 0 && cj.fuel?.verified_by === 2, JSON.stringify(cj.fuel));

  const bad1 = await api("/v1/classifications", customer.key, { input: "x", labels: ["only-one"] });
  check("needs at least 2 labels", bad1.status === 400);
  const bad2 = await api("/v1/classifications", customer.key, { input: "x", labels: ["a", "b"], model: "together/whatever" });
  check("other models refused", bad2.status === 400);
  const bad3 = await api("/v1/classifications", customer.key, { input: Array(31).fill("x"), labels: ["a", "b"] });
  check("texts + labels capped at 32", bad3.status === 400);

  const { data: stats } = await db.from("lane_worker_stats").select("wallet, verified, earned_micro").in("wallet", workers.map((w) => w.wallet));
  check("both laptops paid for 2 jobs", stats?.length === 2 && stats.every((s) => s.verified === 2 && s.earned_micro > 0), JSON.stringify(stats));
  stop = true;
  await Promise.race([Promise.all(loops), new Promise((ok) => setTimeout(ok, 25_000))]);
} finally {
  stop = true;
  for (const w of wallets) {
    await db.from("lane_workers").delete().eq("wallet", w);
    await db.from("lane_worker_stats").delete().eq("wallet", w);
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", w);
    await db.from("accounts").delete().eq("wallet", w);
  }
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
