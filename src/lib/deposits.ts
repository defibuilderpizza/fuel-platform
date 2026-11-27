import "server-only";
import { microToUsd } from "@/lib/money";
import { agentFromMemos, creditFor, depositWallet, findDeposit, isSignature, solUsdPrice } from "@/lib/solana";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isSanctioned } from "@/lib/compliance";

const MIN_CREDIT_MICRO = 100_000; // $0.10

type Row = {
  signature: string;
  wallet: string;
  supporter_wallet?: string | null;
  via?: string;
  asset: string;
  amount_raw: string | number;
  usd_price: number | null;
  credited_micro: number;
  created_at: string;
};

export function depositView(d: Row, justCredited: boolean) {
  return {
    signature: d.signature,
    wallet: d.wallet,
    supporter_wallet: d.supporter_wallet ?? null,
    via: d.via ?? "direct",
    asset: d.asset,
    amount: Number(d.amount_raw) / (d.asset === "SOL" ? 1e9 : 1e6),
    sol_usd_price: d.usd_price,
    credited_usd: microToUsd(d.credited_micro),
    credited_now: justCredited,
    created_at: d.created_at,
  };
}

export type ConfirmResult =
  | { ok: true; status: 200 | 201; deposit: ReturnType<typeof depositView> }
  | { ok: false; status: number; code: string; message: string };

/**
 * Reads a transaction from the chain and credits it once. The payer is credited, unless the
 * transaction carries a "fuel:<agent>" memo naming a registered agent (community top-up), or
 * the payer is a fee wallet linked to an agent (self-fuelling). Unknown names fall back to the payer.
 */
export async function confirmDeposit(signature: string): Promise<ConfirmResult> {
  const deposit = depositWallet();
  if (!deposit) return { ok: false, status: 503, code: "not_configured", message: "Deposits are not open yet." };
  if (!isSignature(signature)) return { ok: false, status: 400, code: "invalid_request_error", message: "'signature' must be a Solana transaction signature." };

  const db = supabaseAdmin();
  const { data: existing } = await db.from("deposits").select("*").eq("signature", signature).maybeSingle();
  if (existing) return { ok: true, status: 200, deposit: depositView(existing, false) };

  let found;
  try {
    found = await findDeposit(signature, deposit);
  } catch {
    return { ok: false, status: 503, code: "server_error", message: "Could not read the chain right now. Try again shortly." };
  }
  if (!found.ok) {
    const message = {
      not_found: "Transaction not found or not finalized yet. Finalization takes ~15 seconds; try again.",
      failed_tx: "That transaction failed on-chain, so nothing was received.",
      no_deposit: "That transaction did not send USDC or SOL to Fuel's deposit address.",
      unknown_sender: "Could not tell which wallet paid in that transaction.",
    }[found.reason];
    return { ok: false, status: found.reason === "not_found" ? 404 : 400, code: found.reason, message };
  }

  // A sanctioned sender is never credited; the transfer is recorded for an admin to handle.
  if (await isSanctioned(found.wallet)) {
    await db.from("blocked_deposits").upsert(
      { signature, sender: found.wallet, asset: found.asset, amount_raw: found.amountRaw.toString(), reason: "sanctioned_sender" },
      { onConflict: "signature", ignoreDuplicates: true },
    );
    return { ok: false, status: 403, code: "sanctioned", message: "This deposit can't be credited (sanctions screening)." };
  }

  let price: number | null = null;
  if (found.asset === "SOL") {
    try {
      price = await solUsdPrice();
    } catch {
      return { ok: false, status: 503, code: "server_error", message: "SOL price unavailable right now. Your deposit is safe; confirm again in a minute." };
    }
  }
  const credit = creditFor(found.asset, found.amountRaw, price);
  if (credit < MIN_CREDIT_MICRO) return { ok: false, status: 400, code: "below_minimum", message: "Deposits under $0.10 are not credited." };

  // Who gets the credit: a "fuel:<agent>" memo first, then a fee wallet linked to an agent
  // (self-fuelling), otherwise the wallet that paid.
  let credited = found.wallet;
  let via: "direct" | "memo" | "fee_source" = "direct";
  const agentName = agentFromMemos(found.memos);
  if (agentName) {
    const { data: agent } = await db.from("agents").select("wallet").eq("name", agentName).maybeSingle();
    if (agent) {
      credited = agent.wallet;
      via = "memo";
    }
  }
  if (via === "direct") {
    const { data: link } = await db.from("agent_fee_sources").select("agent_wallet").eq("source_wallet", found.wallet).maybeSingle();
    if (link) {
      credited = link.agent_wallet;
      via = "fee_source";
    }
  }

  const { error } = await db.rpc("fuel_credit_deposit", {
    p_signature: signature,
    p_wallet: credited,
    p_supporter: found.wallet,
    p_via: via,
    p_asset: found.asset,
    p_amount_raw: found.amountRaw.toString(),
    p_usd_price: price,
    p_credit: credit,
    p_slot: found.slot,
  });
  if (error) return { ok: false, status: 500, code: "server_error", message: "Could not credit the deposit. It is safe on-chain; confirm again." };
  const { data: row } = await db.from("deposits").select("*").eq("signature", signature).single();
  return { ok: true, status: 201, deposit: depositView(row, true) };
}
