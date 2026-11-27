import "server-only";
import { createPublicClient, defineChain, http, parseAbiItem, type Hash, type Log } from "viem";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { walletRefusal } from "@/lib/compliance";

// USDG on Robinhood Chain (Arbitrum Orbit L2, chain 4663). Verified 2026-11-27: USDG is
// "Global Dollar", 6 decimals (1 USDG unit = 1 USD micro), EIP-712 domain version "1"
// (supports EIP-3009 transferWithAuthorization). Top-ups are USDG transfers to Fuel's address on
// Robinhood Chain; the sending wallet is credited (signed in with that EVM wallet).

export const RH_CHAIN_ID = 4663;
export const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const USDG_DOMAIN = { name: "Global Dollar", version: "1" } as const;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SCAN_STATE = "robinhood:usdg";

export const robinhoodChain = defineChain({
  id: RH_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

/** Fuel's USDG receiving address, or null when USDG top-ups aren't switched on. */
export function usdgDepositAddress(): `0x${string}` | null {
  const a = process.env.FUEL_RH_DEPOSIT_ADDRESS?.trim();
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a.toLowerCase() as `0x${string}`) : null;
}

export const rhClient = () => createPublicClient({ chain: robinhoodChain, transport: http(process.env.FUEL_RH_RPC_URL?.trim() || undefined, { timeout: 20_000 }) });

type Credit = { id: string; wallet: string; amountMicro: number; block: bigint };

async function credit(c: Credit): Promise<{ credited: boolean; refused?: string }> {
  const refused = await walletRefusal(c.wallet);
  if (refused) return { credited: false, refused };
  const { data } = await supabaseAdmin().rpc("fuel_credit_deposit", { p_signature: c.id, p_wallet: c.wallet, p_asset: "USDG", p_amount_raw: c.amountMicro, p_usd_price: null, p_credit: c.amountMicro, p_slot: Number(c.block) });
  return { credited: data === true };
}

const creditsIn = (logs: Log<bigint, number, false, typeof TRANSFER>[], to: string): Credit[] =>
  logs
    .filter((l) => l.args.to?.toLowerCase() === to && (l.args.value ?? 0n) > 0n && l.transactionHash && l.logIndex !== null)
    .map((l) => ({ id: `${l.transactionHash}:${l.logIndex}`, wallet: l.args.from!.toLowerCase(), amountMicro: Number(l.args.value), block: l.blockNumber ?? 0n }));

/** Confirms a USDG top-up by transaction hash: credits each USDG transfer in it to Fuel's address. */
export async function confirmUsdgDeposit(txHash: string) {
  const to = usdgDepositAddress();
  if (!to) return { ok: false as const, status: 503, code: "not_configured", message: "USDG top-ups aren't switched on yet." };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false as const, status: 400, code: "bad_hash", message: "'tx_hash' must be a 0x… transaction hash." };
  const client = rhClient();
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
  } catch {
    return { ok: false as const, status: 404, code: "not_found", message: "Transaction not found on Robinhood Chain yet. Try again in a few seconds." };
  }
  if (receipt.status !== "success") return { ok: false as const, status: 409, code: "failed_tx", message: "That transaction failed on-chain." };
  const { decodeEventLog } = await import("viem");
  const transfers: Credit[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDG_ADDRESS.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      if (ev.args.to.toLowerCase() === to && ev.args.value > 0n) transfers.push({ id: `${log.transactionHash}:${log.logIndex}`, wallet: ev.args.from.toLowerCase(), amountMicro: Number(ev.args.value), block: log.blockNumber });
    } catch {}
  }
  if (!transfers.length) return { ok: false as const, status: 409, code: "no_deposit", message: "No USDG transfer to Fuel's address in that transaction." };
  let creditedMicro = 0;
  for (const t of transfers) {
    const r = await credit(t);
    if (r.refused) return { ok: false as const, status: 403, code: "wallet_refused", message: r.refused };
    if (r.credited) creditedMicro += t.amountMicro;
  }
  return { ok: true as const, wallet: transfers[0].wallet, credited_usd: creditedMicro / 1e6, already_credited: creditedMicro === 0, tx_hash: txHash };
}

/** Cron: finds USDG transfers to Fuel's address since the last run and credits them. */
export async function scanUsdgDeposits() {
  const to = usdgDepositAddress();
  if (!to) return { skipped: "not_configured" };
  const client = rhClient();
  const db = supabaseAdmin();
  const latest = await client.getBlockNumber();
  const { data: st } = await db.from("chain_scan_state").select("last_block").eq("chain", SCAN_STATE).maybeSingle();
  // First run: look back about an hour of blocks (Robinhood Chain makes several blocks a second).
  let from = st ? BigInt(st.last_block) + 1n : latest > 20_000n ? latest - 20_000n : 0n;
  let found = 0;
  let credited = 0;
  while (from <= latest) {
    const toBlock = from + 9_999n < latest ? from + 9_999n : latest;
    const logs = await client.getLogs({ address: USDG_ADDRESS, event: TRANSFER, args: { to }, fromBlock: from, toBlock });
    for (const c of creditsIn(logs, to)) {
      found++;
      if ((await credit(c)).credited) credited++;
    }
    await db.from("chain_scan_state").upsert({ chain: SCAN_STATE, last_block: Number(toBlock), updated_at: new Date().toISOString() });
    from = toBlock + 1n;
  }
  return { found, credited, last_block: Number(latest) };
}

/** USDG this transaction sent to `to` (summed), and from whom. For checking payouts. */
export async function usdgSentTo(txHash: string, to: string): Promise<{ ok: true; amount: bigint; from: string[] } | { ok: false; reason: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: "not a transaction hash" };
  const receipt = await rhClient().getTransactionReceipt({ hash: txHash as Hash }).catch(() => null);
  if (!receipt) return { ok: false, reason: "transaction not found on Robinhood Chain" };
  if (receipt.status !== "success") return { ok: false, reason: "transaction failed" };
  const { decodeEventLog } = await import("viem");
  let amount = 0n;
  const from: string[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDG_ADDRESS.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      if (ev.args.to.toLowerCase() === to.toLowerCase()) {
        amount += ev.args.value;
        from.push(ev.args.from.toLowerCase());
      }
    } catch {}
  }
  return amount > 0n ? { ok: true, amount, from } : { ok: false, reason: "no USDG sent to that wallet in this transaction" };
}

/** Recent USDG transfers from Fuel's deposit wallet to `to` (for matching payouts automatically). */
export async function usdgPaymentsFromFuel(to: string, lookbackBlocks = 200_000n) {
  const from = usdgDepositAddress();
  if (!from) return [];
  const client = rhClient();
  const latest = await client.getBlockNumber();
  const out: { hash: string; amount: bigint }[] = [];
  for (let start = latest > lookbackBlocks ? latest - lookbackBlocks : 0n; start <= latest; start += 50_000n) {
    const end = start + 49_999n < latest ? start + 49_999n : latest;
    const logs = await client.getLogs({ address: USDG_ADDRESS, event: TRANSFER, args: { from, to: to as `0x${string}` }, fromBlock: start, toBlock: end });
    for (const l of logs) if (l.transactionHash) out.push({ hash: l.transactionHash, amount: l.args.value ?? 0n });
  }
  return out;
}
