// One-time setup of Fuel's Privacy Rings receiver wallet.
// Run: node --env-file=.env.local scripts/ring-setup.mjs <keypair.json> [--register] [--network devnet]
//
// - Reads a solana-keygen keypair file (kept OFF the server, e.g. ~/.config/solana/fuel/ring.json).
// - Writes FUEL_RING_ADDRESS and FUEL_RING_DERIVATION_SEED into .env.local (never printed).
//   The derivation seed lets Fuel decrypt incoming payments but not spend them.
// - With --register: registers the wallet in the on-chain registry (needs ~0.003 SOL for rent + fee)
//   and turns on merge encryption so many small top-ups can be merged later.
import { readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  signTransactionWithSigners,
} from "@solana/kit";
import {
  MergeEncryptionScheme,
  ShieldedKeypair,
  SigningKey,
  buildRegistrationTransaction,
  buildSetMergeEncryptionTransaction,
  initializePoseidon,
} from "@heliuslabs/spr";
import { SignedTeePolicy, SprClient } from "@heliuslabs/spr/client";
import { ed25519DerivationMessage } from "@heliuslabs/spr/keypair";

const [file] = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== "devnet");
const network = process.argv.includes("devnet") ? "devnet" : "mainnet";
if (!file) {
  console.error("usage: ring-setup.mjs <keypair.json> [--register] [--network devnet]");
  process.exit(1);
}
await initializePoseidon();
const bytes = new Uint8Array(JSON.parse(readFileSync(file, "utf8")));
const seed = bytes.slice(0, 32);
const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
const derivation = ed25519.sign(ed25519DerivationMessage(ed25519.getPublicKey(seed)), seed);

// .env.local: replace or append the two lines
const envPath = ".env.local";
let env = readFileSync(envPath, "utf8");
const set = (k, v) => {
  const line = `${k}=${v}`;
  env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), line) : env.trimEnd() + `\n${line}\n`;
};
if (!/^# Private top-ups/m.test(env)) env = env.trimEnd() + "\n\n# Private top-ups (Privacy Rings receiver; keypair stays offline)\n";
set("FUEL_RING_ADDRESS", signer.address);
set("FUEL_RING_DERIVATION_SEED", Buffer.from(derivation).toString("hex"));
set("FUEL_RING_NETWORK", network);
writeFileSync(envPath, env);
console.log(`ring address: ${signer.address} (${network})`);
console.log("wrote FUEL_RING_ADDRESS, FUEL_RING_DERIVATION_SEED, FUEL_RING_NETWORK to .env.local");

const main = process.env.SOLANA_RPC_URL;
const key = new URL(main).searchParams.get("api-key");
const rpcUrl = network === "devnet" ? `https://devnet.helius-rpc.com/?api-key=${key}` : main;
const client = new SprClient({
  solanaRpcUrl: rpcUrl,
  solanaRpcSubscriptionsUrl: rpcUrl.replace(/^https/, "wss"),
  proverTee: SignedTeePolicy.forNetwork(network),
});
const rpc = createSolanaRpc(rpcUrl);
const lamports = Number((await rpc.getBalance(signer.address).send()).value);
console.log(`balance: ${lamports / 1e9} SOL`);

const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed));
const registration = await buildRegistrationTransaction({ client, owner: signer.address, address: keypair.shieldedAddress() });
if (!registration) {
  console.log("registry: already registered with these keys");
} else if (!process.argv.includes("--register")) {
  console.log("registry: NOT registered yet (re-run with --register once the address holds ~0.003 SOL)");
} else {
  if (lamports < 3_000_000) {
    console.error("Not enough SOL to register: send ~0.003 SOL to the ring address first.");
    process.exit(1);
  }
  const send = sendAndConfirmTransactionFactory({ rpc: client.solanaRpc, rpcSubscriptions: client.solanaRpcSubscriptions });
  const submit = async (tx) => {
    const signed = await signTransactionWithSigners([signer], tx);
    await send(signed, { commitment: "confirmed" });
    return getSignatureFromTransaction(signed);
  };
  console.log("registered:", await submit(registration));
  const merge = await buildSetMergeEncryptionTransaction({ client, owner: signer.address, scheme: MergeEncryptionScheme.PoseidonCtrV1 });
  console.log("merge encryption on:", await submit(merge));
}
process.exit(0);
