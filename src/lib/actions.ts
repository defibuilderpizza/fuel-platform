import "server-only";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { MEMO_PROGRAM, USDC_MINT, depositWallet } from "@/lib/solana";

// Solana Actions (the spec behind Blinks): a wallet or Blink client asks us for a transaction,
// the user signs it in their own wallet. Fuel never holds the user's keys or funds in flight.
// Every transaction pays Fuel's deposit wallet and carries a "fuel:<agent>" memo.

export const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export const ACTION_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "X-Action-Version": "2.4",
  "X-Blockchain-Ids": MAINNET,
};

export function actionJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: ACTION_HEADERS });
}
export function actionError(message: string, status = 400) {
  return actionJson({ message }, status);
}

function rpc() {
  return createSolanaRpc(process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com");
}

export const LIMITS = { USDC: { min: 0.1, max: 10_000 }, SOL: { min: 0.001, max: 100 } } as const;

/** Builds an unsigned transfer to Fuel's deposit wallet with the agent memo. */
export async function buildFuelTransaction(input: { account: string; agent: string; asset: "USDC" | "SOL"; amount: number }) {
  const deposit = depositWallet();
  if (!deposit) return { error: "Top-ups are not open yet." };
  const payer = createNoopSigner(address(input.account));
  const r = rpc();
  const instructions: Instruction[] = [];

  if (input.asset === "USDC") {
    const raw = BigInt(Math.round(input.amount * 1e6));
    const mint = address(USDC_MINT);
    const [source] = await findAssociatedTokenPda({ owner: payer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [destination] = await findAssociatedTokenPda({ owner: address(deposit), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [src, dst] = await Promise.all([
      r.getTokenAccountBalance(source).send().catch(() => null),
      r.getAccountInfo(destination, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }).send(),
    ]);
    if (!src || BigInt(src.value.amount) < raw) return { error: `This wallet doesn't hold ${input.amount} USDC.` };
    if (!dst.value) {
      instructions.push(getCreateAssociatedTokenIdempotentInstruction({ payer, ata: destination, owner: address(deposit), mint }));
    }
    instructions.push(getTransferCheckedInstruction({ source, mint, destination, authority: payer, amount: raw, decimals: 6 }));
  } else {
    const lamports = BigInt(Math.round(input.amount * 1e9));
    const bal = await r.getBalance(payer.address).send();
    if (BigInt(bal.value) < lamports + 10_000n) return { error: `This wallet doesn't hold ${input.amount} SOL plus the network fee.` };
    instructions.push(getTransferSolInstruction({ source: payer, destination: address(deposit), amount: lamports }));
  }
  instructions.push(getAddMemoInstruction({ memo: `fuel:${input.agent}` }, { programAddress: address(MEMO_PROGRAM) }));

  const { value: blockhash } = await r.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return { transaction: getBase64EncodedWireTransaction(compileTransaction(message)) };
}

export function siteUrl(req: Request) {
  return process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(req.url).origin;
}
