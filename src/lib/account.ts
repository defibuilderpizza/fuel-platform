import "server-only";
import { microToUsd, usdToMicro } from "@/lib/money";
import { depositWallet, USDC_MINT } from "@/lib/solana";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { faucetStatus } from "@/lib/faucet";
import { RH_CHAIN_ID, USDG_ADDRESS, usdgDepositAddress } from "@/lib/robinhood";

/** The account as GET /v1/account returns it. */
export async function accountView(wallet: string) {
  const db = supabaseAdmin();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [{ data: a }, { data: today }, { count }, { data: agent }, faucet] = await Promise.all([
    db.from("accounts").select("*").eq("wallet", wallet).single(),
    db.from("jobs").select("price_micro").eq("wallet", wallet).eq("status", "succeeded").gte("created_at", dayStart.toISOString()),
    db.from("jobs").select("id", { count: "exact", head: true }).eq("wallet", wallet).eq("status", "succeeded"),
    db.from("agents").select("name, display_name, description, x_handle, website").eq("wallet", wallet).maybeSingle(),
    faucetStatus(wallet),
  ]);
  const spentToday = (today ?? []).reduce((s, j) => s + Number(j.price_micro ?? 0), 0);
  return {
    wallet,
    balance_usd: microToUsd(a?.balance_micro),
    held_usd: microToUsd(a?.held_micro),
    // own money + usable credit, rounded to the micro-dollar (no float noise)
    available_usd: Math.round((microToUsd(Math.max(0, Number(a?.balance_micro ?? 0) - Number(a?.held_micro ?? 0))) + faucet.credit.available_usd) * 1e6) / 1e6,
    spent_today_usd: microToUsd(spentToday),
    jobs_completed: count ?? 0,
    agent: agent ?? null,
    faucet,
    limits: {
      daily_usd: a?.daily_limit_micro == null ? null : microToUsd(a.daily_limit_micro),
      per_job_usd: a?.per_job_limit_micro == null ? null : microToUsd(a.per_job_limit_micro),
      remaining_today_usd: a?.daily_limit_micro == null ? null : microToUsd(Math.max(0, Number(a.daily_limit_micro) - spentToday)),
    },
    deposit: wallet.startsWith("0x")
      ? {
          chain: "robinhood",
          chain_id: RH_CHAIN_ID,
          address: usdgDepositAddress(),
          assets: { USDG: USDG_ADDRESS },
          how: "Send USDG on Robinhood Chain from this wallet to the address, then POST /v1/topups/usdg with { tx_hash }. 1 USDG = $1.",
        }
      : {
          chain: "solana",
          address: depositWallet(),
          assets: { USDC: USDC_MINT, SOL: "native" },
          how: "Send USDC or SOL from this wallet to the address, then POST /v1/topups with the transaction signature.",
        },
  };
}


/** Saves spending limits (USD; null removes one). Returns an error message or null. */
export async function setLimits(wallet: string, body: { daily_usd?: unknown; per_job_usd?: unknown }): Promise<string | null> {
  const update: Record<string, number | null> = {};
  for (const [field, column] of [["daily_usd", "daily_limit_micro"], ["per_job_usd", "per_job_limit_micro"]] as const) {
    if (!(field in body)) continue;
    const v = body[field];
    if (v === null) update[column] = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0) update[column] = usdToMicro(v);
    else return `'${field}' must be a non-negative number or null.`;
  }
  if (Object.keys(update).length) {
    const { error } = await supabaseAdmin().from("accounts").update(update).eq("wallet", wallet);
    if (error) return "Could not save limits.";
  }
  return null;
}
