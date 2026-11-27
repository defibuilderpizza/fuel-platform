import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isSignature } from "@/lib/solana";
import { BRIDGE_WALLET, TxFailed, burnTransaction, creditTokensEnabled, mintCredits, network, onchainSupply, readBurn, seriesMint, txStatus } from "@/lib/credit-token";

// Moving compute credits between Fuel balances and SPL tokens. See src/lib/credit-token.ts.

const MICRO = 1_000_000;
type Fail = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): Fail => ({ ok: false, status, code, message });

function toUnits(credits: unknown): bigint | null {
  const n = Number(credits);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = BigInt(Math.round(n * MICRO));
  return u > 0n ? u : null;
}

async function bridgeHoldings(series: string): Promise<bigint> {
  const { data } = await supabaseAdmin().from("credit_lots").select("units_left_micro").eq("wallet", BRIDGE_WALLET).eq("series_id", series).eq("status", "open");
  return (data ?? []).reduce((t, l) => t + BigInt(l.units_left_micro), 0n);
}

/** Tokens on-chain may never exceed the credits held for them. If they do, the series stops bridging. */
async function invariantHolds(series: string) {
  const [held, supply] = await Promise.all([bridgeHoldings(series), onchainSupply(series)]);
  return { ok: supply <= held, held, supply };
}

export async function tokenInfo(series?: string) {
  if (!creditTokensEnabled()) return { enabled: false as const };
  const { data } = await supabaseAdmin().from("credit_mints").select("series_id, mint").eq("network", network());
  const mints = (data ?? []).filter((m) => !series || m.series_id === series);
  return { enabled: true as const, network: network(), decimals: 6, mints: mints.map((m) => ({ series: m.series_id, mint: m.mint })) };
}

const OUT_ERR: Record<string, [number, string]> = {
  bad_amount: [400, "Amount must be positive."],
  no_series: [404, "No such credit series."],
  series_expiring: [400, "This series expires within a day: use the credits instead of withdrawing them."],
  not_enough_credits: [400, "You don't hold that many credits in this series (credits in open sell orders don't count)."],
};

/** Withdraw credits of a series to the wallet as SPL tokens. */
export async function withdrawCredits(wallet: string, series: string, credits: unknown) {
  if (!creditTokensEnabled()) return fail(503, "not_configured", "Credit tokens aren't switched on.");
  const units = toUnits(credits);
  if (!units) return fail(400, "invalid_request_error", "'credits' must be a positive number.");
  const inv = await invariantHolds(series).catch(() => null);
  if (!inv) return fail(503, "server_error", "Couldn't read the chain right now. Try again shortly.");
  if (!inv.ok) return fail(503, "bridge_halted", "Bridging for this series is paused for a check. Your credits are safe.");
  await seriesMint(series); // create the mint first, so a failure there costs nothing
  const id = randomUUID();
  const db = supabaseAdmin();
  const { data: r, error } = await db.rpc("fuel_credit_bridge_out", { p_id: id, p_wallet: wallet, p_series: series, p_units: units.toString() });
  if (error) return fail(500, "server_error", "Could not start the withdrawal.");
  if (r !== "ok") {
    const [status, message] = OUT_ERR[String(r)] ?? [400, "Withdrawal refused."];
    return fail(status, String(r), message);
  }
  try {
    const signature = await mintCredits(series, wallet, units, id, async (sig) => {
      await db.from("credit_bridge").update({ signature: sig }).eq("id", id);
    });
    await db.rpc("fuel_credit_bridge_out_done", { p_id: id, p_signature: signature });
    return { ok: true as const, id, series, credits: Number(units) / MICRO, signature, mint: await seriesMint(series), network: network() };
  } catch (e) {
    if (e instanceof TxFailed) {
      await db.rpc("fuel_credit_bridge_out_refund", { p_id: id, p_note: e.message });
      return fail(502, "mint_failed", "The token mint failed, so your credits were put back. Try again.");
    }
    // Might still land: leave it pending; the cron settles it from the chain.
    return { ok: true as const, id, series, credits: Number(units) / MICRO, pending: true, note: "Sent; confirming on-chain. It shows as done within a few minutes." };
  }
}

/** Unsigned burn transaction for the holder to sign and send (base64). */
export async function depositTransaction(wallet: string, series: string, credits: unknown) {
  if (!creditTokensEnabled()) return fail(503, "not_configured", "Credit tokens aren't switched on.");
  const units = toUnits(credits);
  if (!units) return fail(400, "invalid_request_error", "'credits' must be a positive number.");
  const { data: s } = await supabaseAdmin().from("credit_series").select("expires_at").eq("id", series).maybeSingle();
  if (!s) return fail(404, "no_series", "No such credit series.");
  if (Date.parse(s.expires_at) <= Date.now()) return fail(400, "series_expired", "This series has expired; its tokens can't be deposited.");
  const tx = await burnTransaction(series, wallet, units);
  return { ok: true as const, ...tx, series, credits: Number(units) / MICRO, network: network(), next: "Sign and send this transaction from your wallet, then POST /v1/credits/tokens/deposit { series, signature }." };
}

const IN_ERR: Record<string, [number, string]> = {
  already_credited: [409, "That burn was already credited."],
  no_series: [404, "No such credit series."],
  series_expired: [400, "This series has expired; its tokens can't be deposited."],
  bridge_short: [503, "Bridging for this series is paused for a check. Contact Fuel."],
};

/** Credit a burn of credit tokens back to the burning wallet. Anyone can submit the signature. */
export async function depositCredits(series: string, signature: unknown) {
  if (!creditTokensEnabled()) return fail(503, "not_configured", "Credit tokens aren't switched on.");
  if (!isSignature(signature)) return fail(400, "invalid_request_error", "'signature' must be a Solana transaction signature.");
  const burn = await readBurn(signature, series).catch(() => null);
  if (!burn) return fail(503, "server_error", "Couldn't read the chain right now. Try again shortly.");
  if (!burn.ok) {
    const msg = { not_found: "Transaction not found or not confirmed yet. Try again in a few seconds.", failed_tx: "That transaction failed on-chain.", no_burn: "That transaction doesn't burn this series' credit tokens.", several_owners: "Burns from several wallets in one transaction aren't supported." }[burn.reason];
    return fail(burn.reason === "not_found" ? 404 : 400, burn.reason, msg ?? "Not a credit burn.");
  }
  const inv = await invariantHolds(series).catch(() => null);
  if (!inv) return fail(503, "server_error", "Couldn't read the chain right now. Try again shortly.");
  if (!inv.ok) return fail(503, "bridge_halted", "Bridging for this series is paused for a check. Your burn is recorded on-chain; contact Fuel.");
  const { data: r, error } = await supabaseAdmin().rpc("fuel_credit_bridge_in", { p_id: randomUUID(), p_wallet: burn.owner, p_series: series, p_units: burn.units.toString(), p_signature: signature });
  if (error) return fail(500, "server_error", "Could not credit the deposit.");
  if (r !== "ok") {
    const [status, message] = IN_ERR[String(r)] ?? [400, "Deposit refused."];
    return fail(status, String(r), message);
  }
  return { ok: true as const, wallet: burn.owner, series, credits: Number(burn.units) / MICRO };
}

/** Cron: settle withdrawals whose mint was sent but not confirmed in time. */
export async function reconcileBridge() {
  if (!creditTokensEnabled()) return { enabled: false };
  const db = supabaseAdmin();
  const { data } = await db.from("credit_bridge").select("id, signature, created_at").eq("direction", "out").eq("status", "pending").lt("created_at", new Date(Date.now() - 90_000).toISOString()).limit(50);
  let done = 0;
  let refunded = 0;
  for (const b of data ?? []) {
    const st = b.signature ? await txStatus(b.signature).catch(() => "unknown" as const) : null;
    if (st === "landed") {
      await db.rpc("fuel_credit_bridge_out_done", { p_id: b.id, p_signature: b.signature });
      done++;
    } else if (st === "failed" || (st === null && Date.now() - Date.parse(b.created_at) > 5 * 60_000)) {
      // Failed, or never seen after 5 minutes (its blockhash has long expired, so it can't land).
      await db.from("credit_bridge").update({ signature: null }).eq("id", b.id);
      await db.rpc("fuel_credit_bridge_out_refund", { p_id: b.id, p_note: st === "failed" ? "mint failed" : "mint never landed" });
      refunded++;
    }
  }
  return { pending: data?.length ?? 0, done, refunded };
}

/** Admin: per series, credits held for tokens vs on-chain supply. */
export async function bridgeReport() {
  if (!creditTokensEnabled()) return { enabled: false };
  const { data } = await supabaseAdmin().from("credit_mints").select("series_id, mint").eq("network", network());
  const rows = await Promise.all(
    (data ?? []).map(async (m) => {
      const inv = await invariantHolds(m.series_id).catch(() => null);
      return { series: m.series_id, mint: m.mint, held_credits: inv ? Number(inv.held) / MICRO : null, onchain_supply: inv ? Number(inv.supply) / MICRO : null, ok: inv?.ok ?? null };
    }),
  );
  return { enabled: true, network: network(), series: rows };
}
