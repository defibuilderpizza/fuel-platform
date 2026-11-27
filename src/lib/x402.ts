import "server-only";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  address,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Transaction,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { depositWallet, USDC_MINT, MEMO_PROGRAM } from "@/lib/solana";
import { walletRefusal } from "@/lib/compliance";
import { apiError } from "@/lib/http";
import { authenticate, type Caller } from "@/lib/auth";
import { checkEvmPayment, evmRequirements, evmX402Config, evmX402Public, settleEvmPayment } from "@/lib/x402-evm";

// x402 (v2, "exact" scheme on Solana): an agent with no API key gets a 402 whose
// PAYMENT-REQUIRED header names a USDC amount; it signs a USDC transfer to Fuel and resends the
// request with PAYMENT-SIGNATURE. Fuel checks the transaction, adds its fee-payer signature,
// submits it, credits the paying wallet's balance (like any deposit) and runs the job as that
// wallet. Settlement is "upfront": the money lands before the job runs, so a failed job costs
// nothing and whatever the job didn't use stays in the wallet's Fuel balance.

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
/** SPL Memo (v2, the spec's), the newer Memo program, and Memo v1. */
const MEMO_PROGRAMS = new Set([MEMO_PROGRAM, "Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const CAIP2 = { mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" } as const;
/** Smallest x402 charge: the Solana fee Fuel pays to submit it must stay small next to it. */
export const X402_MIN_MICRO = 10_000; // $0.01
const MAX_FEE_LAMPORTS = 20_000; // signatures + priority fee Fuel will sponsor per payment
const MAX_CU_PRICE_MICROLAMPORTS = 5_000_000n; // spec ceiling: 5 lamports per compute unit

/** Whether x402 is on and on which network, from env only (safe while prerendering: no key work). */
export function x402Public(): { network: string; usdg: string | null } | null {
  if (process.env.FUEL_X402_ENABLED !== "1" || !process.env.FUEL_X402_FEE_PAYER) return null;
  return { network: CAIP2[process.env.FUEL_X402_NETWORK === "devnet" ? "devnet" : "mainnet"], usdg: evmX402Public()?.network ?? null };
}

export function x402Config() {
  if (process.env.FUEL_X402_ENABLED !== "1" || !process.env.FUEL_X402_FEE_PAYER) return null;
  const net = process.env.FUEL_X402_NETWORK === "devnet" ? "devnet" : "mainnet";
  const payTo = process.env.FUEL_X402_PAY_TO?.trim() || depositWallet();
  const asset = process.env.FUEL_X402_ASSET?.trim() || (net === "mainnet" ? USDC_MINT : "");
  if (!payTo || !asset) return null;
  const secret = bs58.decode(process.env.FUEL_X402_FEE_PAYER);
  const seed = secret.slice(0, 32);
  const feePayer = bs58.encode(ed25519.getPublicKey(seed));
  const rpcUrl = net === "mainnet" ? process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com" : process.env.FUEL_X402_RPC_URL?.trim() || "https://api.devnet.solana.com";
  return { net, network: CAIP2[net], payTo, asset, feePayer, seed, rpcUrl };
}
type Config = NonNullable<ReturnType<typeof x402Config>>;

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** What a request costs over x402 (the job's hold, at least $0.01), as PaymentRequirements. */
function requirements(cfg: Config, amountMicro: number) {
  return {
    scheme: "exact",
    network: cfg.network,
    amount: String(Math.max(amountMicro, X402_MIN_MICRO)),
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer: cfg.feePayer, paymentFlow: "upfront" },
  };
}

function paymentRequired(cfg: Config | null, req: Request, amountMicro: number, error?: string) {
  const amount = String(Math.max(amountMicro, X402_MIN_MICRO));
  const evm = evmX402Config();
  const accepts = [...(cfg ? [requirements(cfg, amountMicro)] : []), ...(evm ? [evmRequirements(evm, amount)] : [])];
  const reqs = { amount };
  const pr = {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: req.url, description: "One Fuel compute job. Whatever the job doesn't use stays in your wallet's Fuel balance.", mimeType: "application/json", serviceName: "Fuel" },
    accepts,
  };
  return new Response(
    JSON.stringify({
      error: {
        message: error ?? `Payment required: ${(Number(reqs.amount) / 1e6).toFixed(6)} ${[cfg ? "USDC on Solana" : "", evm ? "USDG on Robinhood Chain" : ""].filter(Boolean).join(" or ")} (x402), or send an API key.`,
        type: "payment_required",
        code: "x402_payment_required",
      },
      x402: pr,
    }),
    { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64json(pr), "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" } },
  );
}

const u64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true);

type Checked = { ok: true; tx: Transaction; payer: string; amount: bigint } | { ok: false; reason: string };

/** The spec's checks for an "exact" SVM payment (static layout only; smart wallets aren't accepted). */
export async function checkPayment(cfg: Config, base64Tx: string, minAmount: bigint): Promise<Checked> {
  let tx: Transaction;
  try {
    tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64Tx)) as Transaction;
  } catch {
    return { ok: false, reason: "invalid_transaction" };
  }
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    header: { numSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    addressTableLookups?: unknown[];
  };
  if (msg.addressTableLookups?.length) return { ok: false, reason: "address_lookup_tables_not_supported" };
  const keys = msg.staticAccounts;
  if (msg.header.numSignerAccounts !== 2) return { ok: false, reason: "expected_two_signers" };
  if (keys[0] !== cfg.feePayer) return { ok: false, reason: "wrong_fee_payer" };
  const ix = msg.instructions;
  if (ix.length < 3 || ix.length > 7) return { ok: false, reason: "unexpected_instruction_count" };

  let cuLimit = 0;
  let cuPrice = 0n;
  let transfer: { payer: string; amount: bigint } | null = null;
  let memo = false;
  for (let i = 0; i < ix.length; i++) {
    const program = keys[ix[i].programAddressIndex];
    const accts = (ix[i].accountIndices ?? []).map((k) => keys[k]);
    const data = ix[i].data ?? new Uint8Array();
    // The fee payer only pays fees: it must not be in any instruction.
    if (accts.includes(cfg.feePayer)) return { ok: false, reason: "fee_payer_in_instruction" };
    if (i === 0) {
      if (program !== COMPUTE_BUDGET || data[0] !== 2 || data.length < 5) return { ok: false, reason: "expected_compute_unit_limit" };
      cuLimit = u32(data, 1);
    } else if (i === 1) {
      if (program !== COMPUTE_BUDGET || data[0] !== 3 || data.length < 9) return { ok: false, reason: "expected_compute_unit_price" };
      cuPrice = u64(data, 1);
    } else if (i === 2) {
      if ((program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022) || data[0] !== 12 || data.length < 10 || accts.length < 4) return { ok: false, reason: "expected_transfer_checked" };
      const [, mint, destination, authority] = accts;
      if (mint !== cfg.asset) return { ok: false, reason: "wrong_asset" };
      const [ata] = await findAssociatedTokenPda({ owner: address(cfg.payTo), mint: address(cfg.asset), tokenProgram: address(program) });
      if (destination !== ata) return { ok: false, reason: "wrong_recipient" };
      if (data[9] !== 6) return { ok: false, reason: "wrong_decimals" };
      transfer = { payer: authority, amount: u64(data, 1) };
    } else if (MEMO_PROGRAMS.has(program)) {
      memo = true;
    } else if (program !== LIGHTHOUSE) {
      return { ok: false, reason: "unexpected_instruction" };
    }
  }
  if (!transfer) return { ok: false, reason: "expected_transfer_checked" };
  if (!memo) return { ok: false, reason: "memo_required" };
  if (transfer.amount < minAmount) return { ok: false, reason: "insufficient_amount" };
  if (keys[1] !== transfer.payer) return { ok: false, reason: "transfer_authority_must_sign" };
  if (cuPrice > MAX_CU_PRICE_MICROLAMPORTS) return { ok: false, reason: "compute_unit_price_too_high" };
  const fee = 2 * 5000 + Number((cuPrice * BigInt(cuLimit)) / 1_000_000n);
  if (fee > MAX_FEE_LAMPORTS) return { ok: false, reason: "priority_fee_too_high" };

  // The payer has signed; the fee payer's slot is still empty.
  const sigs = tx.signatures as Record<string, Uint8Array | null>;
  const payerSig = sigs[transfer.payer];
  if (!payerSig || !ed25519.verify(payerSig, msgBytes(tx), bs58.decode(transfer.payer))) return { ok: false, reason: "invalid_payer_signature" };
  const feeSig = sigs[cfg.feePayer];
  if (feeSig && feeSig.some((b) => b !== 0)) return { ok: false, reason: "fee_payer_already_signed" };

  return { ok: true, tx, payer: transfer.payer, amount: transfer.amount };
}

/** The message bytes as a plain Uint8Array (for signing and verifying). */
const msgBytes = (tx: Transaction) => new Uint8Array(tx.messageBytes);

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Adds Fuel's fee-payer signature, submits, and waits for confirmation. Returns the tx signature. */
async function settle(cfg: Config, tx: Transaction): Promise<{ ok: true; signature: string } | { ok: false; reason: string }> {
  const feeSig = ed25519.sign(msgBytes(tx), cfg.seed);
  const signed = { ...tx, signatures: { ...tx.signatures, [cfg.feePayer]: feeSig } } as Transaction;
  const wire = getBase64EncodedWireTransaction(signed as Parameters<typeof getBase64EncodedWireTransaction>[0]);
  const signature = bs58.encode(feeSig); // the fee payer signs first, so this is the tx signature
  const rpc = createSolanaRpc(cfg.rpcUrl);
  try {
    await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  } catch (e) {
    // Already submitted (a retry of the same payment) is fine: confirmation decides.
    if (!/already been processed|AlreadyProcessed/i.test(String((e as Error).message))) return { ok: false, reason: "submit_failed" };
  }
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    const s = value[0];
    if (s?.err) return { ok: false, reason: "transaction_failed" };
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return { ok: true, signature };
    await sleep(750);
  }
  return { ok: false, reason: "not_confirmed" };
}

/** What the confirmed transaction actually paid into payTo, read from the chain. */
async function received(cfg: Config, signature: string): Promise<{ amount: bigint; slot: number } | null> {
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const tx = (await rpc
    .getTransaction(signature as never, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    .send()) as unknown as { slot: number; meta: { err: unknown; preTokenBalances?: Bal[]; postTokenBalances?: Bal[] } } | null;
  if (!tx || tx.meta.err) return null;
  type Bal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
  const mine = (l?: Bal[]) => new Map((l ?? []).filter((b) => b.mint === cfg.asset && b.owner === cfg.payTo).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
  const pre = mine(tx.meta.preTokenBalances);
  const post = mine(tx.meta.postTokenBalances);
  let amount = 0n;
  for (const [i, after] of post) amount += after - (pre.get(i) ?? 0n);
  return amount > 0n ? { amount, slot: Number(tx.slot) } : null;
}

/**
 * For a request with no API key: returns a 402 to ask for payment, or settles the payment in
 * PAYMENT-SIGNATURE and returns the paying wallet as the caller. Null when x402 is off.
 */
export async function x402Caller(req: Request, holdMicro: number): Promise<{ caller: Caller; paymentResponse: string; signature: string } | Response | null> {
  const cfg = x402Config();
  const evm = evmX402Config();
  if (!cfg && !evm) return null;
  const need = BigInt(Math.max(holdMicro, X402_MIN_MICRO));
  const header = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  if (!header) return paymentRequired(cfg, req, holdMicro);

  let payload: { x402Version?: number; accepted?: { scheme?: string; network?: string }; payload?: { transaction?: string; signature?: string; authorization?: Record<string, string> } };
  try {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return paymentRequired(cfg, req, holdMicro, "PAYMENT-SIGNATURE isn't base64 JSON.");
  }
  if (payload.accepted?.scheme && payload.accepted.scheme !== "exact") return paymentRequired(cfg, req, holdMicro, "Only the 'exact' scheme is accepted.");

  // USDG on Robinhood Chain (EIP-3009 authorization).
  if (payload.payload?.authorization || payload.accepted?.network?.startsWith("eip155:")) {
    if (!evm) return paymentRequired(cfg, req, holdMicro, "USDG on Robinhood Chain isn't accepted right now.");
    if (payload.accepted?.network && payload.accepted.network !== evm.network) return paymentRequired(cfg, req, holdMicro, `Pay on ${evm.network}.`);
    const c = await checkEvmPayment(evm, payload.payload ?? {}, need);
    if (!c.ok) return paymentRequired(cfg, req, holdMicro, `Payment rejected: ${c.reason}.`);
    const s = await settleEvmPayment(evm, c, new URL(req.url).pathname);
    if ("refused" in s && s.refused) return apiError(403, "permission_error", s.refused, "wallet_refused");
    if (!s.ok) {
      if (s.reason === "not_confirmed") return apiError(502, "server_error", "Payment was submitted but not confirmed yet. If it lands, the deposit scanner credits it to your wallet's Fuel balance.", "x402_not_confirmed");
      return paymentRequired(cfg, req, holdMicro, `Payment didn't settle: ${s.reason}. You weren't charged.`);
    }
    const paymentResponse = b64json({ success: true, transaction: s.hash, network: evm.network, payer: s.payer, amount: s.amount.toString() });
    return { caller: { wallet: s.payer, keyId: "x402" }, paymentResponse, signature: s.hash };
  }

  if (!cfg) return paymentRequired(cfg, req, holdMicro, `Pay with USDG on ${evm!.network}.`);
  if (payload.accepted?.network && payload.accepted.network !== cfg.network) return paymentRequired(cfg, req, holdMicro, `Pay on ${cfg.network}.`);
  const b64 = payload.payload?.transaction;
  if (typeof b64 !== "string" || b64.length > 4000) return paymentRequired(cfg, req, holdMicro, "payload.transaction (base64) is required.");

  const c = await checkPayment(cfg, b64, need);
  if (!c.ok) return paymentRequired(cfg, req, holdMicro, `Payment rejected: ${c.reason}.`);
  const refused = await walletRefusal(c.payer);
  if (refused) return apiError(403, "permission_error", refused, "wallet_refused");

  const db = supabaseAdmin();
  const feeSig = bs58.encode(ed25519.sign(msgBytes(c.tx), cfg.seed));
  const { data: used } = await db.from("x402_payments").select("signature").eq("signature", feeSig).maybeSingle();
  if (used) return paymentRequired(cfg, req, holdMicro, "This payment was already used (duplicate_settlement). Sign a new one.");

  const s = await settle(cfg, c.tx);
  if (!s.ok) return paymentRequired(cfg, req, holdMicro, `Payment didn't settle: ${s.reason}. You weren't charged.`);
  const got = await received(cfg, s.signature);
  if (!got || got.amount < need) return apiError(502, "server_error", "Payment settled but couldn't be read back yet. It will be credited to your wallet's Fuel balance by the deposit scanner.", "x402_readback_failed");

  // Credit it like any deposit (idempotent per signature), then claim it for this request.
  await db.rpc("fuel_credit_deposit", { p_signature: s.signature, p_wallet: c.payer, p_asset: "USDC", p_amount_raw: Number(got.amount), p_usd_price: null, p_credit: Number(got.amount), p_slot: got.slot });
  const { error: claimErr } = await db.from("x402_payments").insert({ signature: s.signature, wallet: c.payer, network: cfg.network, amount_micro: Number(got.amount), resource: new URL(req.url).pathname });
  if (claimErr) return paymentRequired(cfg, req, holdMicro, "This payment was already used (duplicate_settlement). Sign a new one.");

  const paymentResponse = b64json({ success: true, transaction: s.signature, network: cfg.network, payer: c.payer, amount: got.amount.toString() });
  return { caller: { wallet: c.payer, keyId: "x402" }, paymentResponse, signature: s.signature };
}

/**
 * A request with no key, no payment and an incomplete body (a directory's probe, or an agent
 * checking the price) gets the payment offer at the minimum instead of a 400, so x402 discovery
 * sees a real 402. Null when x402 is off or a payment was sent (then the normal 400 applies).
 */
export async function x402Probe(req: Request): Promise<Response | null> {
  if (req.headers.get("authorization") || req.headers.get("payment-signature") || req.headers.get("x-payment")) return null;
  const cfg = x402Config();
  if (!cfg && !evmX402Config()) return null;
  return paymentRequired(cfg, req, X402_MIN_MICRO);
}

/**
 * For compute endpoints: the API key's caller, or null when there's no Authorization header and
 * x402 is on (the job then asks for payment). A bad key is still a 401.
 */
export async function callerOrPay(req: Request): Promise<Caller | null | Response> {
  if (!req.headers.get("authorization") && (x402Config() || evmX402Config())) return null;
  return authenticate(req);
}

/** Links the request's job to its payment (for receipts and support). */
export async function x402LinkJob(signature: string, jobId: string) {
  await supabaseAdmin().from("x402_payments").update({ job_id: jobId }).eq("signature", signature);
}
