// x402 payment checks, offline (no network, no database writes): builds real Solana
// transactions locally and runs them through checkPayment.
//   npx tsx --conditions=react-server --env-file=.env.local scripts/x402-check-test.mts
import "./test-guard.mjs";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";

const key = async () => {
  const seed = ed25519.utils.randomSecretKey();
  const bytes = new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]);
  return { signer: await createKeyPairSignerFromBytes(bytes), secret: bs58.encode(bytes) };
};
const fee = await key();
const payTo = await key();
const agent = await key();
const mint = (await key()).signer.address;
process.env.FUEL_X402_ENABLED = "1";
process.env.FUEL_X402_NETWORK = "devnet";
process.env.FUEL_X402_FEE_PAYER = fee.secret;
process.env.FUEL_X402_ASSET = mint;
process.env.FUEL_X402_PAY_TO = payTo.signer.address;
const mod: any = await import("../src/lib/x402.ts");
const X = mod.checkPayment ? mod : mod.default;
const cfg = X.x402Config();

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const cb = (data: number[]): Instruction => ({ programAddress: address("ComputeBudget111111111111111111111111111111"), data: new Uint8Array(data) });
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
const BLOCKHASH = { blockhash: bs58.encode(crypto.getRandomValues(new Uint8Array(32))) as never, lastValidBlockHeight: 100n };

async function build(o: { amount?: bigint; to?: string; feePayer?: string; cuPrice?: bigint; cuLimit?: number; memo?: boolean; authority?: "agent" | "fee"; extra?: Instruction; tamper?: boolean } = {}) {
  const [from] = await findAssociatedTokenPda({ owner: agent.signer.address, mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [to] = await findAssociatedTokenPda({ owner: address(o.to ?? payTo.signer.address), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const auth = o.authority === "fee" ? fee.signer : agent.signer;
  const ixs: Instruction[] = [
    cb([2, ...u32(o.cuLimit ?? 20_000)]),
    cb([3, ...u64(o.cuPrice ?? 1_000n)]),
    getTransferCheckedInstruction({ source: from, mint: address(mint), destination: to, authority: auth, amount: o.amount ?? 50_000n, decimals: 6 }),
    ...(o.memo === false ? [] : [getAddMemoInstruction({ memo: "0123456789abcdef0123456789abcdef" })]),
    ...(o.extra ? [o.extra] : []),
  ];
  const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(address(o.feePayer ?? cfg.feePayer), m), (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m), (m) => appendTransactionMessageInstructions(ixs, m));
  const tx = await partiallySignTransaction([auth.keyPair], compileTransaction(msg));
  const out = o.tamper ? { ...tx, signatures: { ...tx.signatures, [agent.signer.address]: new Uint8Array(64).fill(7) } } : tx;
  return getBase64EncodedWireTransaction(out as typeof tx);
}
const reason = async (tx: string, need = 50_000n) => {
  const r = await X.checkPayment(cfg, tx, need);
  return r.ok ? "ok" : r.reason;
};

check("config reads the devnet settings", cfg?.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" && cfg.payTo === payTo.signer.address);
const okRes = await X.checkPayment(cfg, await build(), 50_000n);
if (!okRes.ok) console.log("  reason:", okRes.reason);
check("a correct payment passes, payer = transfer authority", okRes.ok && okRes.payer === agent.signer.address && okRes.amount === 50_000n);
check("overpayment is allowed", (await reason(await build({ amount: 60_000n }))) === "ok");
check("underpayment refused", (await reason(await build({ amount: 49_999n }))) === "insufficient_amount");
check("wrong recipient refused", (await reason(await build({ to: agent.signer.address }))) === "wrong_recipient");
check("another fee payer refused", (await reason(await build({ feePayer: agent.signer.address }))) !== "ok");
check("fee payer moving its own funds refused", (await reason(await build({ authority: "fee" }))) !== "ok");
check("missing memo refused", (await reason(await build({ memo: false }))) === "memo_required");
check("priority fee above the cap refused", (await reason(await build({ cuPrice: 5_000_000n, cuLimit: 400_000 }))) === "priority_fee_too_high");
check("compute unit price above 5 lamports/CU refused", (await reason(await build({ cuPrice: 6_000_000n, cuLimit: 1 }))) === "compute_unit_price_too_high");
check("a forged payer signature refused", (await reason(await build({ tamper: true }))) === "invalid_payer_signature");
const sys: Instruction = { programAddress: address("11111111111111111111111111111111"), data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) };
check("an extra unknown instruction refused", (await reason(await build({ extra: sys }))) === "unexpected_instruction");
check("garbage refused", (await reason("bm90IGEgdHJhbnNhY3Rpb24=")) === "invalid_transaction");
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
