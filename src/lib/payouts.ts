import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import bs58 from "bs58";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { microToUsd, usdToMicro } from "@/lib/money";
import { isSignature, signaturesFor, usdcReceivedBy, USDC_MINT } from "@/lib/solana";
import { RH_CHAIN_ID, USDG_ADDRESS, usdgPaymentsFromFuel, usdgSentTo } from "@/lib/robinhood";

const isEvm = (w: string) => /^0x[0-9a-fA-F]{40}$/.test(w);

// Payouts of earnings (sellers, laptop-lane workers): USDC on Solana, or USDG on Robinhood Chain
// for EVM wallets. Fuel never holds a key that can
// send money: an admin approves a request, signs the transfer in their own wallet from a
// Solana Pay link, and the cron (or the admin, with a signature) matches it on-chain.

export const payoutMinMicro = () => usdToMicro(Math.max(1, Number(process.env.FUEL_PAYOUT_MIN_USD) || 5));

export type PayoutRow = {
  id: string;
  wallet: string;
  amount_micro: number;
  status: "requested" | "approved" | "paid" | "rejected" | "cancelled";
  reference: string;
  signature: string | null;
  note: string | null;
  requested_at: string;
  decided_at: string | null;
  paid_at: string | null;
};

export function payoutView(p: PayoutRow) {
  return {
    id: p.id,
    amount_usd: microToUsd(p.amount_micro),
    status: p.status,
    signature: p.signature,
    note: p.note,
    requested_at: p.requested_at,
    decided_at: p.decided_at,
    paid_at: p.paid_at,
  };
}

/** Solana Pay transfer request: opens the admin's wallet with recipient, amount, USDC and reference filled in. */
export function payLink(p: Pick<PayoutRow, "id" | "wallet" | "amount_micro" | "reference">) {
  // EVM wallets: an EIP-681 USDG transfer on Robinhood Chain (USDG has 6 decimals, so micro = units).
  if (isEvm(p.wallet)) return `ethereum:${USDG_ADDRESS}@${RH_CHAIN_ID}/transfer?address=${p.wallet}&uint256=${p.amount_micro}`;
  const amount = (p.amount_micro / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
  const q = new URLSearchParams({
    amount,
    "spl-token": USDC_MINT,
    reference: p.reference,
    label: "Fuel",
    message: "Fuel earnings payout",
    memo: `fuel-payout:${p.id}`,
  });
  return `solana:${p.wallet}?${q.toString()}`;
}

export async function payoutSummary(wallet: string) {
  const db = supabaseAdmin();
  const [{ data: available }, { data: earned }, { data: rows }] = await Promise.all([
    db.rpc("fuel_payout_available", { p_wallet: wallet }),
    db.from("ledger_entries").select("delta_micro").eq("wallet", wallet).in("source", ["seller_payout", "lane_payout"]),
    db.from("payouts").select("*").eq("wallet", wallet).order("requested_at", { ascending: false }).limit(50),
  ]);
  const list = (rows ?? []) as PayoutRow[];
  return {
    available_usd: microToUsd(Number(available ?? 0)),
    earned_total_usd: microToUsd((earned ?? []).reduce((t, r) => t + Number(r.delta_micro), 0)),
    paid_out_usd: microToUsd(list.filter((p) => p.status === "paid").reduce((t, p) => t + Number(p.amount_micro), 0)),
    minimum_usd: microToUsd(payoutMinMicro()),
    payouts: list.map(payoutView),
  };
}

const REQUEST_ERRORS: Record<string, [number, string]> = {
  no_account: [404, "No Fuel account for this wallet."],
  suspended: [403, "This account is suspended."],
  below_minimum: [400, "Below the minimum payout."],
  payout_open: [409, "You already have a payout waiting. Cancel it or wait until it's paid."],
  insufficient_earnings: [400, "More than you can withdraw. Only earnings (seller and laptop-lane income) can be paid out, up to your spendable balance."],
};

export async function requestPayout(wallet: string, amountUsd: number) {
  const micro = usdToMicro(amountUsd);
  if (!(micro > 0)) return { ok: false as const, status: 400, message: "'amount_usd' must be a positive number." };
  const id = randomUUID();
  // A fresh random public key used only as a Solana Pay reference. No private key is kept.
  const reference = bs58.encode(randomBytes(32));
  const { data, error } = await supabaseAdmin().rpc("fuel_payout_request", { p_id: id, p_wallet: wallet, p_micro: micro, p_min: payoutMinMicro(), p_reference: reference });
  if (error) return { ok: false as const, status: 500, message: "Could not create the payout." };
  if (data !== "ok") {
    const [status, message] = REQUEST_ERRORS[String(data)] ?? [400, "Payout refused."];
    return { ok: false as const, status, message: data === "below_minimum" ? `${message} Minimum is $${microToUsd(payoutMinMicro())}.` : message, code: String(data) };
  }
  const { data: row } = await supabaseAdmin().from("payouts").select("*").eq("id", id).single();
  return { ok: true as const, payout: payoutView(row as PayoutRow) };
}

export async function closePayout(id: string, status: "rejected" | "cancelled", note?: string, wallet?: string) {
  const { data, error } = await supabaseAdmin().rpc("fuel_payout_close", { p_id: id, p_status: status, p_note: note?.slice(0, 500) ?? null, p_wallet: wallet ?? null });
  if (error) return "error";
  return String(data);
}

export async function approvePayout(id: string) {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("payouts")
    .update({ status: "approved", decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "requested")
    .select("*")
    .maybeSingle();
  if (error || !data) return null;
  return data as PayoutRow;
}

/**
 * Checks a transfer against an approved payout: finalized, USDC to the payout's wallet, at least
 * the amount, and not already used for another payout. Marks it paid when it matches.
 */
export async function settlePayout(p: PayoutRow, signature: string): Promise<{ ok: boolean; reason?: string }> {
  if (p.status !== "approved") return { ok: false, reason: `payout is ${p.status}` };
  if (isEvm(p.wallet)) {
    const t = await usdgSentTo(signature, p.wallet);
    if (!t.ok) return { ok: false, reason: t.reason };
    if (t.amount < BigInt(p.amount_micro)) return { ok: false, reason: `sent ${microToUsd(Number(t.amount))} USDG, payout is ${microToUsd(p.amount_micro)}` };
  } else {
    if (!isSignature(signature)) return { ok: false, reason: "not a transaction signature" };
    const t = await usdcReceivedBy(signature, p.wallet);
    if (!t.ok) return { ok: false, reason: t.reason };
    if (t.amountRaw < BigInt(p.amount_micro)) return { ok: false, reason: `sent ${microToUsd(Number(t.amountRaw))} USDC, payout is ${microToUsd(p.amount_micro)}` };
  }
  const { data, error } = await supabaseAdmin()
    .from("payouts")
    .update({ status: "paid", signature, paid_at: new Date().toISOString() })
    .eq("id", p.id)
    .eq("status", "approved")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, reason: error.code === "23505" ? "that transaction already paid another payout" : "database error" };
  return data ? { ok: true } : { ok: false, reason: "payout changed meanwhile" };
}

/** Cron: finds the transfer for each approved payout by its Solana Pay reference. */
export async function reconcilePayouts() {
  const { data } = await supabaseAdmin().from("payouts").select("*").eq("status", "approved").limit(50);
  let paid = 0;
  for (const p of (data ?? []) as PayoutRow[]) {
    if (isEvm(p.wallet)) {
      // Only transfers from Fuel's own USDG wallet count, so someone else's payment can't settle it.
      for (const t of await usdgPaymentsFromFuel(p.wallet).catch(() => [])) {
        if (t.amount < BigInt(p.amount_micro)) continue;
        if ((await settlePayout(p, t.hash)).ok) {
          paid++;
          break;
        }
      }
      continue;
    }
    const sigs = await signaturesFor(p.reference, 10).catch(() => []);
    for (const s of sigs) {
      if (s.err) continue;
      const r = await settlePayout(p, s.signature);
      if (r.ok) {
        paid++;
        break;
      }
    }
  }
  return { approved: data?.length ?? 0, paid };
}
