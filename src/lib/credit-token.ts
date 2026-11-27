import "server-only";
import bs58 from "bs58";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getBurnCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
} from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Compute credits as SPL tokens: one fungible mint per monthly series, 6 decimals, so 1 token
// base unit = 1 micro-credit (1 token = 1 credit). Off by default (FUEL_CREDIT_TOKENS_ENABLED=1).
//
//   withdraw: the holder's credits move to Fuel's bridge account and Fuel mints the same number
//             of tokens to the holder's wallet.
//   deposit:  the holder burns tokens (a transaction they sign; Fuel builds it for them) and
//             gets the same number of credits back from the bridge account.
// Fuel's total obligation never changes, so the reserve, the cap and expiry work as before.
// Invariant, checked before every bridge move: the bridge's credits in a series == the mint's
// on-chain supply. If they ever differ (tokens minted outside Fuel), that series stops bridging.
//
// The mint authority is a dedicated key (FUEL_CREDIT_MINT_AUTHORITY, base58 64-byte secret) that
// can only mint credit tokens and pays the network fees. Mints have no freeze authority.

export const BRIDGE_WALLET = "fuel:credit-bridge";
export const DECIMALS = 6;

export function creditTokensEnabled() {
  return process.env.FUEL_CREDIT_TOKENS_ENABLED === "1" && !!process.env.FUEL_CREDIT_MINT_AUTHORITY;
}
export function network(): "mainnet" | "devnet" {
  return process.env.FUEL_CREDIT_TOKEN_NETWORK === "mainnet" ? "mainnet" : "devnet";
}
function rpcUrl() {
  if (process.env.FUEL_CREDIT_TOKEN_RPC_URL) return process.env.FUEL_CREDIT_TOKEN_RPC_URL;
  return network() === "mainnet" ? (process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com") : "https://api.devnet.solana.com";
}
const rpc = () => createSolanaRpc(rpcUrl());

let authorityCache: KeyPairSigner | null = null;
async function authority() {
  authorityCache ??= await createKeyPairSignerFromBytes(bs58.decode(process.env.FUEL_CREDIT_MINT_AUTHORITY ?? ""));
  return authorityCache;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export class TxFailed extends Error {} // definitely didn't land: safe to undo
export class TxUncertain extends Error {} // may still land: don't undo, reconcile later

/**
 * Signs with the authority (plus any extra signers in the instructions), reports the signature
 * before sending (so it can be saved), sends, and waits for confirmation.
 */
async function sendSigned(instructions: Instruction[], onSigned?: (signature: string) => Promise<void>) {
  const payer = await authority();
  const { value: blockhash } = await rpc().getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  if (onSigned) await onSigned(signature);
  try {
    await rpc().sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  } catch (e) {
    // Rejected in preflight (simulation): it was never broadcast.
    throw new TxFailed(String((e as Error).message ?? e).slice(0, 200));
  }
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc().getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st?.err) throw new TxFailed(`transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature as string;
    await sleep(750);
  }
  throw new TxUncertain(`not confirmed in time: ${signature}`);
}

/** The series' mint address, created on first use. */
export async function seriesMint(series: string): Promise<string> {
  const db = supabaseAdmin();
  const net = network();
  const { data } = await db.from("credit_mints").select("mint").eq("series_id", series).eq("network", net).maybeSingle();
  if (data?.mint) return data.mint;
  const payer = await authority();
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const lamports = await rpc().getMinimumBalanceForRentExemption(BigInt(space)).send();
  await sendSigned([
    getCreateAccountInstruction({ payer, newAccount: mint, lamports, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: payer.address, freezeAuthority: null }),
  ]);
  // Another request may have created one at the same time: the first row wins, ours is unused.
  const { error } = await db.from("credit_mints").insert({ series_id: series, network: net, mint: mint.address });
  if (error) {
    const { data: again } = await db.from("credit_mints").select("mint").eq("series_id", series).eq("network", net).single();
    return again!.mint;
  }
  return mint.address;
}

/** Mints `units` micro-credits of `series` to `owner` (creating their token account if needed). */
export async function mintCredits(series: string, owner: string, units: bigint, ref: string, onSigned?: (signature: string) => Promise<void>) {
  const mint = address(await seriesMint(series));
  const payer = await authority();
  const ownerAddr = address(owner);
  const [token] = await findAssociatedTokenPda({ owner: ownerAddr, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return sendSigned([
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: ownerAddr, mint }),
    getMintToCheckedInstruction({ mint, token, mintAuthority: payer, amount: units, decimals: DECIMALS }),
    getAddMemoInstruction({ memo: `fuel-credit-out:${ref}` }),
  ], onSigned);
}

/** Unsigned transaction for `owner` to burn `units` of `series` (they sign and send it). */
export async function burnTransaction(series: string, owner: string, units: bigint) {
  const mint = address(await seriesMint(series));
  const ownerAddr = address(owner);
  const [account] = await findAssociatedTokenPda({ owner: ownerAddr, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const { value: blockhash } = await rpc().getLatestBlockhash({ commitment: "confirmed" }).send();
  // Signer placeholder: only the address is used to compile; the holder's wallet signs.
  const holder = { address: ownerAddr } as unknown as KeyPairSigner;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(ownerAddr, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([getBurnCheckedInstruction({ account, mint, authority: holder, amount: units, decimals: DECIMALS }), getAddMemoInstruction({ memo: `fuel-credit-in:${series}` })], m),
  );
  return { transaction: getBase64EncodedWireTransaction(compileTransaction(message)), mint: mint as string };
}

type ParsedIx = { program?: string; programId?: string; parsed?: { type?: string; info?: Record<string, unknown> } };

/** Reads a burn of `series` tokens: who burned how much. */
export async function readBurn(signature: string, series: string): Promise<{ ok: true; owner: string; units: bigint } | { ok: false; reason: string }> {
  const mint = await seriesMint(series);
  const tx = await rpc()
    .getTransaction(signature as Parameters<ReturnType<typeof rpc>["getTransaction"]>[0], { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    .send()
    .catch(() => null);
  if (!tx) return { ok: false, reason: "not_found" };
  if (tx.meta?.err) return { ok: false, reason: "failed_tx" };
  let owner: string | null = null;
  let units = 0n;
  for (const ix of tx.transaction.message.instructions as unknown as ParsedIx[]) {
    const t = ix.parsed?.type;
    const info = ix.parsed?.info ?? {};
    if (ix.programId !== TOKEN_PROGRAM_ADDRESS || (t !== "burn" && t !== "burnChecked") || info.mint !== mint) continue;
    const who = String(info.authority ?? info.multisigAuthority ?? "");
    if (owner && owner !== who) return { ok: false, reason: "several_owners" };
    owner = who;
    const amt = (info.tokenAmount as { amount?: string } | undefined)?.amount ?? (info.amount as string | undefined) ?? "0";
    units += BigInt(amt);
  }
  if (!owner || units <= 0n) return { ok: false, reason: "no_burn" };
  return { ok: true, owner, units };
}

/** On-chain supply of a series' mint, in micro-credits (0 if no mint yet). */
export async function onchainSupply(series: string): Promise<bigint> {
  const { data } = await supabaseAdmin().from("credit_mints").select("mint").eq("series_id", series).eq("network", network()).maybeSingle();
  if (!data?.mint) return 0n;
  const { value } = await rpc().getTokenSupply(address(data.mint) as Address).send();
  return BigInt(value.amount);
}

/** Status of a transaction Fuel sent: landed, failed, or unknown (null). */
export async function txStatus(signature: string): Promise<"landed" | "failed" | null> {
  const { value } = await rpc().getSignatureStatuses([signature as Parameters<ReturnType<typeof rpc>["getSignatureStatuses"]>[0][number]], { searchTransactionHistory: true }).send();
  const st = value[0];
  if (!st) return null;
  if (st.err) return "failed";
  return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" ? "landed" : null;
}
