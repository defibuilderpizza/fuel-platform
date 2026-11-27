// Pays for ONE Fuel request with USDG on Robinhood Chain over x402 (real money, about $0.01).
// The payer key is read from your own env file and never printed or sent anywhere: only the
// signed authorization goes to Fuel.
//   1) Put the paying wallet's private key in .env.payer (gitignored):  PAYER_KEY=0x...
//   2) node --env-file=.env.payer scripts/x402-pay-usdg.mjs [https://fuelai.cloud]
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const BASE = (process.argv[2] ?? "https://fuelai.cloud").replace(/\/$/, "");
const key = process.env.PAYER_KEY?.trim();
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Set PAYER_KEY=0x… (64 hex) in .env.payer");
const payer = privateKeyToAccount(key);
const url = `${BASE}/v1/chat/completions`;
const body = JSON.stringify({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "Say hello from Robinhood Chain in five words." }], max_tokens: 32 });

const first = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}: ${await first.text()}`);
const pr = JSON.parse(Buffer.from(first.headers.get("payment-required"), "base64").toString());
const req = pr.accepts.find((a) => a.network === "eip155:4663");
if (!req) throw new Error("Fuel isn't offering USDG on Robinhood Chain right now.");
console.log(`Fuel asks ${Number(req.amount) / 1e6} USDG to ${req.payTo} (payer ${payer.address})`);

const now = Math.floor(Date.now() / 1000);
const authorization = { from: payer.address, to: req.payTo, value: req.amount, validAfter: "0", validBefore: String(now + 120), nonce: `0x${randomBytes(32).toString("hex")}` };
const signature = await payer.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId: 4663, verifyingContract: req.asset },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
});
const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: req, payload: { signature, authorization } })).toString("base64");

const paid = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header }, body });
const out = await paid.json().catch(() => ({}));
const receipt = paid.headers.get("payment-response");
console.log("status:", paid.status);
if (receipt) console.log("payment:", JSON.parse(Buffer.from(receipt, "base64").toString()));
console.log("answer:", out.choices?.[0]?.message?.content ?? JSON.stringify(out).slice(0, 300));
