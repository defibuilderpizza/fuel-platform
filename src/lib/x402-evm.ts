import "server-only";
import { createWalletClient, decodeEventLog, http, parseAbi, parseAbiItem, parseSignature, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { walletRefusal } from "@/lib/compliance";
import { rhClient, robinhoodChain, RH_CHAIN_ID, USDG_ADDRESS, USDG_DOMAIN, usdgDepositAddress } from "@/lib/robinhood";

// x402 "exact" on EVM (EIP-3009): the agent signs a USDG transferWithAuthorization to Fuel's
// Robinhood Chain address; Fuel checks it, submits it from its gas wallet (paying the ETH fee),
// credits the payer's balance like any USDG deposit (same id "tx:logIndex", so the deposit scanner
// can't credit it twice) and runs the job as that wallet. Upfront, like the Solana flow.

export const RH_CAIP2 = `eip155:${RH_CHAIN_ID}`;
const ABI = parseAbi(["function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"]);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** On when x402 is on, a USDG deposit address is set and the gas wallet key is present. */
export function evmX402Config() {
  if (process.env.FUEL_X402_ENABLED !== "1" || process.env.FUEL_X402_EVM === "0") return null;
  const payTo = usdgDepositAddress();
  const key = process.env.FUEL_RH_GAS_PRIVATE_KEY?.trim();
  if (!payTo || !key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return { network: RH_CAIP2, payTo, asset: USDG_ADDRESS, key: key as Hex };
}
type EvmConfig = NonNullable<ReturnType<typeof evmX402Config>>;

/** For docs and llms.txt, from env only (no key work). */
export const evmX402Public = () =>
  process.env.FUEL_X402_ENABLED === "1" && process.env.FUEL_X402_EVM !== "0" && !!process.env.FUEL_RH_DEPOSIT_ADDRESS && !!process.env.FUEL_RH_GAS_PRIVATE_KEY ? { network: RH_CAIP2 } : null;

export function evmRequirements(cfg: EvmConfig, amount: string) {
  return { scheme: "exact", network: cfg.network, amount, asset: cfg.asset, payTo: cfg.payTo, maxTimeoutSeconds: 60, extra: { ...USDG_DOMAIN, paymentFlow: "upfront" } };
}

export type Authorization = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
type Checked = { ok: true; auth: { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }; signature: Hex } | { ok: false; reason: string };

const isAddr = (s: unknown): s is Hex => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const big = (s: unknown) => {
  try {
    return typeof s === "string" || typeof s === "number" ? BigInt(s) : null;
  } catch {
    return null;
  }
};

/** The spec's checks for an "exact" EVM payment: recipient, amount, time window, signature. */
export async function checkEvmPayment(cfg: EvmConfig, p: { signature?: unknown; authorization?: Partial<Authorization> }, need: bigint, now = Math.floor(Date.now() / 1000)): Promise<Checked> {
  const a = p.authorization ?? {};
  if (typeof p.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(p.signature)) return { ok: false, reason: "invalid_signature_format" };
  if (!isAddr(a.from) || !isAddr(a.to)) return { ok: false, reason: "invalid_authorization" };
  const value = big(a.value), validAfter = big(a.validAfter), validBefore = big(a.validBefore);
  if (value === null || validAfter === null || validBefore === null || typeof a.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return { ok: false, reason: "invalid_authorization" };
  if (a.to.toLowerCase() !== cfg.payTo) return { ok: false, reason: "wrong_recipient" };
  if (value < need) return { ok: false, reason: "insufficient_amount" };
  if (validBefore < BigInt(now + 6)) return { ok: false, reason: "authorization_expired" };
  if (validAfter > BigInt(now)) return { ok: false, reason: "authorization_not_yet_valid" };
  const auth = { from: a.from, to: a.to, value, validAfter, validBefore, nonce: a.nonce as Hex };
  const good = await verifyTypedData({
    address: a.from,
    domain: { ...USDG_DOMAIN, chainId: RH_CHAIN_ID, verifyingContract: cfg.asset },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: auth,
    signature: p.signature as Hex,
  }).catch(() => false);
  if (!good) return { ok: false, reason: "invalid_payer_signature" };
  return { ok: true, auth, signature: p.signature as Hex };
}

/**
 * Settles a checked payment and credits it. Returns the tx hash and what was credited, or a reason.
 * The whole thing is keyed by the authorization nonce, which the token lets be used only once.
 */
export async function settleEvmPayment(cfg: EvmConfig, c: Extract<Checked, { ok: true }>, resource: string) {
  const payer = c.auth.from.toLowerCase();
  const refused = await walletRefusal(payer);
  if (refused) return { ok: false as const, refused };
  const client = rhClient();
  const { v, r, s } = parseSignature(c.signature);
  const args = [c.auth.from, c.auth.to, c.auth.value, c.auth.validAfter, c.auth.validBefore, c.auth.nonce, Number(v ?? 27n), r, s] as const;
  const account = privateKeyToAccount(cfg.key);
  try {
    // Simulating first catches spent nonces and short balances before Fuel pays any gas.
    await client.simulateContract({ address: cfg.asset, abi: ABI, functionName: "transferWithAuthorization", args, account });
  } catch {
    return { ok: false as const, reason: "simulation_failed (used authorization, or not enough USDG)" };
  }
  let hash: Hex;
  try {
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(process.env.FUEL_RH_RPC_URL?.trim() || undefined, { timeout: 20_000 }) });
    hash = await wallet.writeContract({ address: cfg.asset, abi: ABI, functionName: "transferWithAuthorization", args });
  } catch {
    return { ok: false as const, reason: "submit_failed" };
  }
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 45_000 }).catch(() => null);
  if (!receipt) return { ok: false as const, reason: "not_confirmed", hash };
  if (receipt.status !== "success") return { ok: false as const, reason: "transaction_failed" };
  let credit: { id: string; amount: bigint; block: bigint } | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.asset.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      if (ev.args.to.toLowerCase() === cfg.payTo && ev.args.from.toLowerCase() === payer) credit = { id: `${hash}:${log.logIndex}`, amount: ev.args.value, block: log.blockNumber };
    } catch {}
  }
  if (!credit) return { ok: false as const, reason: "no_transfer_in_receipt", hash };
  const db = supabaseAdmin();
  await db.rpc("fuel_credit_deposit", { p_signature: credit.id, p_wallet: payer, p_asset: "USDG", p_amount_raw: Number(credit.amount), p_usd_price: null, p_credit: Number(credit.amount), p_slot: Number(credit.block) });
  const { error } = await db.from("x402_payments").insert({ signature: hash, wallet: payer, network: cfg.network, amount_micro: Number(credit.amount), resource });
  if (error) return { ok: false as const, reason: "duplicate_settlement" };
  return { ok: true as const, hash, payer, amount: credit.amount };
}
