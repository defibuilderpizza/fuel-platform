import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { microToUsd } from "@/lib/money";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Operations numbers for the admin page. */
export async function GET(req: Request) {
  await connection();
  const denied = requireAdmin(req);
  if (denied) return denied;
  const db = supabaseAdmin();
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const month = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [jobs30, accounts, deposits30, faucet, potUsed, ringReview, scan, pendingSellers, suspended, blocked, sanctioned] = await Promise.all([
    db.from("jobs").select("price_micro, provider_cost_micro, provider, status, created_at").gte("created_at", month).limit(50_000),
    db.from("accounts").select("wallet, balance_micro", { count: "exact" }),
    db.from("deposits").select("credited_micro, via, created_at").gte("created_at", month),
    db.from("faucet_config").select("*").eq("id", 1).single(),
    db.rpc("fuel_pot_used"),
    db.from("ring_receipts").select("signature, status, asset, created_at").neq("status", "credited").order("created_at", { ascending: false }).limit(20),
    db.from("deposit_scan_state").select("address, scanned_at"),
    db.from("sellers").select("id", { count: "exact", head: true }).eq("status", "pending"),
    db.from("accounts").select("wallet, suspended_at, suspended_reason").not("suspended_at", "is", null).order("suspended_at", { ascending: false }).limit(50),
    db.from("blocked_deposits").select("*").order("created_at", { ascending: false }).limit(50),
    db.from("sanctioned_wallets").select("wallet", { count: "exact", head: true }),
  ]);
  const ok = (jobs30.data ?? []).filter((j) => j.status === "succeeded");
  const sum = (rows: { price_micro: number | null; provider_cost_micro: number | null }[]) =>
    rows.reduce((a, j) => ({ charged: a.charged + Number(j.price_micro ?? 0), cost: a.cost + Number(j.provider_cost_micro ?? 0) }), { charged: 0, cost: 0 });
  const m = sum(ok);
  const d = sum(ok.filter((j) => j.created_at >= day));
  const byProvider = new Map<string, number>();
  for (const j of ok) {
    const p = j.provider?.startsWith("seller:") ? "sellers" : (j.provider ?? "unknown");
    byProvider.set(p, (byProvider.get(p) ?? 0) + 1);
  }
  const balances = (accounts.data ?? []).map((a) => Number(a.balance_micro));
  return Response.json({
    jobs: {
      last_24h: ok.filter((j) => j.created_at >= day).length,
      last_30d: ok.length,
      failed_30d: (jobs30.data ?? []).filter((j) => j.status === "failed").length,
      by_provider_30d: Object.fromEntries(byProvider),
    },
    money: {
      charged_24h_usd: microToUsd(d.charged),
      margin_24h_usd: microToUsd(d.charged - d.cost),
      charged_30d_usd: microToUsd(m.charged),
      margin_30d_usd: microToUsd(m.charged - m.cost),
      deposits_30d_usd: microToUsd((deposits30.data ?? []).reduce((t, r) => t + Number(r.credited_micro), 0)),
      customer_balances_usd: microToUsd(balances.filter((b) => b > 0).reduce((t, b) => t + b, 0)),
      credit_owed_usd: microToUsd(-balances.filter((b) => b < 0).reduce((t, b) => t + b, 0)),
    },
    accounts: accounts.count ?? 0,
    faucet: {
      enabled: faucet.data?.enabled ?? false,
      pot_usd: microToUsd(faucet.data?.pot_micro ?? 0),
      pot_used_usd: microToUsd(Number(potUsed.data ?? 0)),
      trial_usd: microToUsd(faucet.data?.trial_micro ?? 0),
      credit_share: Number(faucet.data?.credit_share ?? 0),
    },
    private_topups_needing_review: ringReview.data ?? [],
    deposit_scanner: scan.data ?? [],
    sellers_pending: pendingSellers.count ?? 0,
    compliance: {
      suspended_accounts: suspended.data ?? [],
      blocked_deposits: blocked.data ?? [],
      sanctioned_wallets: sanctioned.count ?? 0,
    },
  });
}
