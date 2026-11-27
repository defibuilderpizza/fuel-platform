import "server-only";
import { createHash, randomUUID } from "node:crypto";
import bs58 from "bs58";
import { address } from "@solana/kit";
import {
  LocalKeys,
  SOL_MINT,
  Wallet,
  getPrivateTransactions,
  initializePoseidon,
  keyedWalletSnapshotCipher,
  loadPersistedWallet,
  syncPersistedWallet,
  walletSnapshotKey,
} from "@heliuslabs/spr";
import { SignedTeePolicy, SprClient } from "@heliuslabs/spr/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { creditFor, solUsdPrice } from "@/lib/solana";

// Private top-ups via Helius Privacy Rings (docs/design/private-topups.md).
//
// Fuel owns a ring-receiver wallet. Agents send it private transfers: the amount is
// encrypted on-chain. Fuel's server holds only the receiver's *derivation signature*,
// which lets it decrypt incoming payments but not spend them (spending also needs the
// receiver's Solana key, which stays offline). The sender is the transfer's public
// signer, so the credit goes to that wallet's normal Fuel balance.

type Network = "mainnet" | "devnet";
const USDC_BY_NETWORK: Record<Network, string> = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};
const CREDITED_KINDS = new Set(["privateTransfer", "deposit"]);

export function ringConfig() {
  const network: Network = process.env.FUEL_RING_NETWORK === "devnet" ? "devnet" : "mainnet";
  const ringAddress = process.env.FUEL_RING_ADDRESS?.trim() || null;
  const seed = process.env.FUEL_RING_DERIVATION_SEED?.trim() || null;
  const enabled = process.env.FUEL_RING_ENABLED === "1" && !!ringAddress && !!seed;
  const allowlist = (process.env.FUEL_RING_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const maxUsd = Number(process.env.FUEL_RING_MAX_USD);
  return { network, ringAddress, seed, enabled, allowlist, maxMicro: Number.isFinite(maxUsd) && maxUsd > 0 ? Math.round(maxUsd * 1e6) : null };
}

function rpcUrl(network: Network) {
  const main = process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
  if (network === "mainnet") return main;
  const key = new URL(main).searchParams.get("api-key");
  return key ? `https://devnet.helius-rpc.com/?api-key=${key}` : "https://api.devnet.solana.com";
}

function decodeSeed(s: string): Uint8Array {
  if (/^[0-9a-f]{128}$/i.test(s)) return new Uint8Array(Buffer.from(s, "hex"));
  const b = bs58.decode(s);
  if (b.length !== 64) throw new Error("FUEL_RING_DERIVATION_SEED must be a 64-byte signature (hex or base58)");
  return b;
}

let poseidonReady: Promise<void> | null = null;

/** The transaction's public signers, and who among them sent it. */
export async function transferSigners(signature: string, network: Network) {
  const res = await fetch(rpcUrl(network), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
    }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = (await res.json()) as {
    result?: { slot: number; meta: { err: unknown } | null; transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } } } | null;
  };
  const tx = body.result;
  if (!tx || !tx.meta) return null;
  const signers = tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);
  const feePayer = signers[0];
  // One signer: they sent it. Two: a sponsor paid the fee, the other one is the owner who spent.
  const others = signers.filter((s) => s !== feePayer);
  const sender = signers.length === 1 ? feePayer : others.length === 1 ? others[0] : null;
  return { slot: tx.slot, failed: !!tx.meta.err, signers, sender };
}

export type ScanResult =
  | { ok: true; recorded: number; credited: number; syncedSlot: string | null }
  | { ok: false; reason: "disabled" | "busy" | "error"; message?: string };

/**
 * Syncs the receiver wallet and records every new inbound ring payment once.
 * Safe to call from several places: a lease lets only one sync run at a time.
 */
export async function scanRing(requireSlot?: number): Promise<ScanResult> {
  const cfg = ringConfig();
  if (!cfg.enabled || !cfg.ringAddress || !cfg.seed) return { ok: false, reason: "disabled" };
  const db = supabaseAdmin();
  const owner = randomUUID();
  const { data: leased } = await db.rpc("fuel_ring_lease", { p_owner: owner, p_seconds: 240 });
  if (!leased) return { ok: false, reason: "busy" };

  let keys: LocalKeys | null = null;
  try {
    poseidonReady ??= initializePoseidon();
    await poseidonReady;
    const client = new SprClient({ solanaRpcUrl: rpcUrl(cfg.network), proverTee: SignedTeePolicy.forNetwork(cfg.network) });
    const seed = decodeSeed(cfg.seed);
    keys = LocalKeys.fromDerivationSeed({ solanaPublicKey: address(cfg.ringAddress), derivationSeed: seed }, client.proofService);
    const identity = keys.address();
    const snapshotKey = createHash("sha256").update("fuel/ring-snapshot/v1").update(seed).digest();
    const cipher = keyedWalletSnapshotCipher(identity, await walletSnapshotKey(new Uint8Array(snapshotKey)));

    const { data: state } = await db.from("ring_state").select("snapshot").eq("id", 1).single();
    const wallet =
      (await loadPersistedWallet({ store: { load: async () => state?.snapshot ?? undefined }, cipher })) ?? new Wallet({ identity });
    await syncPersistedWallet({
      client,
      wallet,
      keys,
      cipher,
      store: {
        save: async (snapshot) => {
          const { error } = await db.from("ring_state").update({ snapshot, synced_at: new Date().toISOString() }).eq("id", 1);
          if (error) throw new Error("could not save ring wallet state");
        },
      },
      config: requireSlot ? { requireSlot: BigInt(requireSlot) } : undefined,
    });

    const inbound = getPrivateTransactions(wallet).filter((t) => t.direction === "inbound");
    const seen = new Set<string>();
    const sigs = [...new Set(inbound.map((t) => String(t.id.signature)))];
    for (let i = 0; i < sigs.length; i += 100) {
      const { data } = await db.from("ring_receipts").select("signature, leaf_index").in("signature", sigs.slice(i, i + 100));
      for (const r of data ?? []) seen.add(`${r.signature}:${r.leaf_index}`);
    }

    let recorded = 0;
    let credited = 0;
    let solPrice: number | null = null;
    const usdc = USDC_BY_NETWORK[cfg.network];
    let maxSlot: bigint | null = null;
    for (const t of inbound) {
      const sig = String(t.id.signature);
      if (maxSlot === null || t.id.slot > maxSlot) maxSlot = t.id.slot;
      if (seen.has(`${sig}:${t.id.index}`)) continue;

      const assetName = t.asset === SOL_MINT ? "SOL" : t.asset === usdc ? "USDC" : String(t.asset);
      const info = CREDITED_KINDS.has(t.kind) ? await transferSigners(sig, cfg.network) : null;
      const sender = info?.sender ?? null;
      let status: "credited" | "unattributed" | "unsupported_asset" | "not_allowlisted" | "over_cap" = "credited";
      let credit = 0;
      let price: number | null = null;
      if (assetName !== "SOL" && assetName !== "USDC") status = "unsupported_asset";
      else if (!sender) status = "unattributed";
      else if (cfg.allowlist.length && !cfg.allowlist.includes(sender)) status = "not_allowlisted";
      else {
        if (assetName === "SOL") price = solPrice ??= await solUsdPrice();
        credit = creditFor(assetName, t.amount, price);
        if (cfg.maxMicro !== null && credit > cfg.maxMicro) status = "over_cap";
      }

      const { data: inserted, error } = await db.rpc("fuel_record_ring", {
        p_signature: sig,
        p_leaf_index: Number(t.id.index),
        p_slot: Number(t.id.slot),
        p_kind: t.kind,
        p_sender: sender,
        p_asset: assetName,
        p_amount_raw: t.amount.toString(),
        p_usd_price: price,
        p_credit: credit,
        p_status: status,
      });
      if (error) throw new Error("could not record ring receipt");
      if (inserted) {
        recorded++;
        if (status === "credited") credited++;
      }
    }
    if (maxSlot !== null) await db.from("ring_state").update({ synced_slot: Number(maxSlot) }).eq("id", 1);
    return { ok: true, recorded, credited, syncedSlot: maxSlot === null ? null : String(maxSlot) };
  } catch (e) {
    // Never log amounts or keys; the error class/code is enough to debug.
    const code = (e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown";
    console.error("ring scan failed:", code);
    return { ok: false, reason: "error", message: String(code) };
  } finally {
    keys?.destroy();
    await db.rpc("fuel_ring_release", { p_owner: owner });
  }
}

export function ringReceiptView(r: {
  signature: string;
  asset: string;
  amount_raw: string | number;
  usd_price: number | null;
  credited_micro: number;
  status: string;
  created_at: string;
}) {
  return {
    signature: r.signature,
    asset: r.asset,
    amount: Number(r.amount_raw) / (r.asset === "SOL" ? 1e9 : 1e6),
    sol_usd_price: r.usd_price,
    credited_usd: Number(r.credited_micro) / 1e6,
    status: r.status,
    created_at: r.created_at,
  };
}
