// Devnet rehearsal of private top-ups (design doc rollout step 1).
// Run: node --env-file=.env.local scripts/ring-devnet.mjs
// A receiver ("Fuel") wallet and an "agent" wallet, both devnet-only throwaways kept in
// ~/.config/solana/fuel/devnet-*.json. The agent funds a private balance and sends a private
// transfer to the receiver. The receiver syncs using ONLY its derivation signature
// (no spending key) and must see the transfer, its amount, and map the sender to the agent.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  getSignatureFromTransaction,
  lamports,
  sendAndConfirmTransactionFactory,
  signTransactionWithSigners,
} from "@solana/kit";
import {
  LocalKeys,
  SOL_MINT,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildDepositTransaction,
  buildRegistrationTransaction,
  buildTransferTransaction,
  fetchViewingKeyOwners,
  getPrivateTransactions,
  initializePoseidon,
  syncWallet,
  viewingKeyIndex,
} from "@heliuslabs/spr";
import { SignedTeePolicy, SprClient } from "@heliuslabs/spr/client";
import { ed25519DerivationMessage } from "@heliuslabs/spr/keypair";

await initializePoseidon();
const heliusKey = new URL(process.env.SOLANA_RPC_URL).searchParams.get("api-key");
const RPC = `https://devnet.helius-rpc.com/?api-key=${heliusKey}`;
const WSS = `wss://devnet.helius-rpc.com/?api-key=${heliusKey}`;
const client = new SprClient({
  solanaRpcUrl: RPC,
  solanaRpcSubscriptionsUrl: WSS,
  // The Helius RPC URL also serves the indexer (Photon) and the prover.
  proverTee: SignedTeePolicy.forNetwork("devnet"),
});
const rpc = createSolanaRpc(RPC);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc: client.solanaRpc, rpcSubscriptions: client.solanaRpcSubscriptions });
const step = (s) => console.log(`\n== ${s}`);

const dir = `${homedir()}/.config/solana/fuel`;
mkdirSync(dir, { recursive: true });
function seedFile(name) {
  const p = `${dir}/devnet-${name}.seed`;
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex"), { mode: 0o600 });
  return new Uint8Array(Buffer.from(readFileSync(p, "utf8").trim(), "hex"));
}

async function party(name) {
  const seed = seedFile(name);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed));
  return { name, seed, signer, keypair };
}

async function submit(tx, signers) {
  const signed = await signTransactionWithSigners(signers, tx);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

async function fund(p, sol) {
  const bal = Number((await rpc.getBalance(p.signer.address).send()).value);
  if (bal >= sol * 1e9 * 0.5) return console.log(`${p.name} has ${bal / 1e9} SOL`);
  const sig = await rpc.requestAirdrop(p.signer.address, lamports(BigInt(sol * 1e9))).send();
  for (let i = 0; i < 30; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`${p.name} airdropped ${sol} devnet SOL`);
}

async function register(p) {
  const tx = await buildRegistrationTransaction({ client, owner: p.signer.address, address: p.keypair.shieldedAddress() });
  if (!tx) return console.log(`${p.name} already registered`);
  console.log(`${p.name} registered: ${await submit(tx, [p.signer])}`);
}

const fuel = await party("receiver");
const agent = await party("agent");
console.log("receiver (Fuel ring address):", fuel.signer.address);
console.log("agent wallet:", agent.signer.address);

step("fund + register");
await fund(fuel, 0.5);
await fund(agent, 1);
await register(fuel);
await register(agent);

step("agent: private balance");
const agentWallet = new Wallet({ identity: agent.keypair.shieldedAddress() });
const agentKeys = LocalKeys.fromKeypair(agent.keypair, client.proofService);
await syncWallet({ client, wallet: agentWallet, keys: agentKeys });
const have = agentWallet.balance(SOL_MINT).amount;
console.log("agent private SOL:", Number(have) / 1e9);
if (have < 50_000_000n) {
  const dep = await buildDepositTransaction({ client, feePayer: agent.signer.address, recipient: agent.keypair.shieldedAddress(), amount: 200_000_000n });
  const slot = await client.confirmTransaction(await submit(dep, [agent.signer]));
  await syncWallet({ client, wallet: agentWallet, keys: agentKeys, config: { requireSlot: slot } });
  console.log("deposited; agent private SOL now:", Number(agentWallet.balance(SOL_MINT).amount) / 1e9);
}

step("agent → Fuel: private transfer of 0.0123 SOL");
const AMOUNT = 12_300_000n;
const tx = await buildTransferTransaction({ client, wallet: agentWallet, keys: agentKeys, feePayer: agent.signer.address, recipient: fuel.signer.address, amount: AMOUNT });
const sig = await submit(tx, [agent.signer]);
const slot = await client.confirmTransaction(sig);
console.log("transfer signature:", sig, "slot", slot);

step("Fuel: sync with the derivation signature only (no spending key)");
const derivationSeed = ed25519.sign(ed25519DerivationMessage(ed25519.getPublicKey(fuel.seed)), fuel.seed);
const viewKeys = LocalKeys.fromDerivationSeed({ solanaPublicKey: fuel.signer.address, derivationSeed }, client.proofService);
const fuelWallet = new Wallet({ identity: viewKeys.address() });
const report = await syncWallet({ client, wallet: fuelWallet, keys: viewKeys, config: { requireSlot: slot } });
console.log("sync report:", JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const incoming = getPrivateTransactions(fuelWallet).filter((t) => t.direction === "inbound");
const owners = await fetchViewingKeyOwners({ rpc: client });
for (const t of incoming) {
  const sender = t.counterpartyViewingPublicKey ? owners.get(viewingKeyIndex(t.counterpartyViewingPublicKey)) : undefined;
  console.log(
    JSON.stringify({ sig: t.id.signature, slot: String(t.id.slot), index: String(t.id.index), kind: t.kind, asset: t.asset, amount: String(t.amount), sender }),
  );
}
const ours = incoming.find((t) => t.id.signature === sig);
const sender = ours?.counterpartyViewingPublicKey ? owners.get(viewingKeyIndex(ours.counterpartyViewingPublicKey)) : undefined;
console.log("\nRESULT:", ours && ours.amount === AMOUNT && sender === agent.signer.address ? "PASS: amount decrypted and sender mapped to the agent wallet" : "FAIL");
process.exit(0);
