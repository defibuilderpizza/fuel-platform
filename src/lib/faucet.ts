import "server-only";
import { markupBps, microToUsd } from "@/lib/money";
import { depositWallet } from "@/lib/solana";
import { ringConfig } from "@/lib/ring";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Credit faucet. Two parts, both paid out of one fixed pot (faucet_config):
// 1. A free trial: a small one-off credit, not repaid, for wallets with real on-chain history.
// 2. Pay-later credit: a wallet may go below zero by up to a share (2%) of everything it has
//    paid in. Any money that comes in pays the debt first. Debt older than the due period
//    freezes jobs until it's paid.
// Credit can only be spent on Fuel jobs: balances are never withdrawable.

const MIN_SOL_LAMPORTS = 5_000_000; // 0.005 SOL: a live wallet, not an empty throwaway
const MIN_TXS = 5;
const MIN_AGE_DAYS = 7;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(method);
  return body.result as T;
}

/** Slows down farming with fresh wallets: needs some SOL and a real transaction history. */
export async function trialEligibility(wallet: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (wallet === depositWallet() || wallet === ringConfig().ringAddress) return { ok: false, reason: "Fuel's own wallets can't claim." };
  const [bal, sigs] = await Promise.all([
    rpc<{ value: number }>("getBalance", [wallet, { commitment: "confirmed" }]),
    rpc<{ blockTime: number | null }[]>("getSignaturesForAddress", [wallet, { limit: 100, commitment: "confirmed" }]),
  ]);
  if (bal.value < MIN_SOL_LAMPORTS) return { ok: false, reason: "The wallet needs at least 0.005 SOL." };
  if (sigs.length < MIN_TXS) return { ok: false, reason: `The wallet needs at least ${MIN_TXS} past transactions.` };
  const oldest = sigs[sigs.length - 1]?.blockTime ?? null;
  const oldEnough = sigs.length >= 100 || (oldest !== null && Date.now() / 1000 - oldest >= MIN_AGE_DAYS * 86_400);
  if (!oldEnough) return { ok: false, reason: `The wallet needs on-chain history going back at least ${MIN_AGE_DAYS} days.` };
  return { ok: true };
}

/** The model the free trial is described in (tokens of it). */
export const TRIAL_REFERENCE_MODEL = "openai/gpt-oss-120b";

export async function faucetStatus(wallet: string) {
  const db = supabaseAdmin();
  const [{ data: cfg }, { data: trial }, { data: acct }, { data: limit }, { data: potUsed }, { data: paid }] = await Promise.all([
    db.from("faucet_config").select("*").eq("id", 1).single(),
    db.from("faucet_trials").select("amount_micro, granted_at").eq("wallet", wallet).maybeSingle(),
    db.from("accounts").select("balance_micro, held_micro, debt_since").eq("wallet", wallet).maybeSingle(),
    db.rpc("fuel_credit_limit", { p_wallet: wallet }),
    db.rpc("fuel_pot_used"),
    db.rpc("fuel_paid_in_total", { p_wallet: wallet }),
  ]);
  // The trial shown as tokens (3:1 in:out) on a reference open model, never as money in copy.
  const { data: ref } = await db.from("provider_models").select("input_per_mtok, output_per_mtok").eq("model", TRIAL_REFERENCE_MODEL).eq("enabled", true).order("input_per_mtok").limit(1).maybeSingle();
  const typical = ref ? ((Number(ref.input_per_mtok) * 3 + Number(ref.output_per_mtok)) / 4) * (1 + markupBps() / 10_000) : 0;
  const trialTokens = typical > 0 ? Math.floor((microToUsd(cfg?.trial_micro ?? 0) / typical) * 1e6) : null;
  const balance = Number(acct?.balance_micro ?? 0);
  const debt = Math.max(0, -balance);
  const due = acct?.debt_since && cfg ? new Date(new Date(acct.debt_since).getTime() + cfg.due_days * 86_400_000) : null;
  const potLeft = Math.max(0, Number(cfg?.pot_micro ?? 0) - Number(potUsed ?? 0));
  return {
    enabled: !!cfg?.enabled,
    trial: {
      amount_usd: microToUsd(cfg?.trial_micro ?? 0),
      tokens_estimate: trialTokens,
      tokens_model: TRIAL_REFERENCE_MODEL,
      claimed: !!trial,
      claimed_at: trial?.granted_at ?? null,
    },
    credit: {
      limit_usd: microToUsd(Number(limit ?? 0)),
      used_usd: microToUsd(debt),
      available_usd: microToUsd(Math.max(0, Math.min(Number(limit ?? 0) - Math.max(0, Number(acct?.held_micro ?? 0) - balance), potLeft))),
      share_of_topups: Number(cfg?.credit_share ?? 0),
      paid_in_total_usd: microToUsd(Number(paid ?? 0)),
      due_at: due?.toISOString() ?? null,
      overdue: !!due && due.getTime() < Date.now(),
    },
    rules: {
      max_credit_per_agent_usd: cfg?.max_per_agent_micro == null ? null : microToUsd(cfg.max_per_agent_micro),
      due_days: cfg?.due_days ?? 0,
      pot_left_usd: microToUsd(potLeft),
      spend_only_on_fuel: true,
    },
  };
}
