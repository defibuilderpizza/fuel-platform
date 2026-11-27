import "server-only";
import bs58 from "bs58";

// Public deposits: the agent sends USDC or SOL to Fuel's deposit wallet, then
// tells us the transaction signature. We read the finalized transaction from
// the chain and credit the wallet that paid. Nothing is trusted from the client
// except the signature itself.

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// SPL Memo v2 (what Fuel writes) plus v1 and the newer memo program (what Fuel accepts).
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_PROGRAMS = new Set([MEMO_PROGRAM, "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", "Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH"]);
const SOL_PRICE_BUFFER = 0.005; // 0.5% for price movement before we convert

export function depositWallet(): string | null {
  return process.env.FUEL_DEPOSIT_WALLET?.trim() || null;
}

function rpcUrl() {
  return process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
}

export function isSignature(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 80 || s.length > 90) return false;
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  return body.result as T;
}

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
type ParsedTx = {
  slot: number;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: string; signer: boolean }[];
      instructions: { programId: string; parsed?: unknown; data?: string }[];
    };
  };
};

/** Memo strings in a transaction (top-level instructions only). */
function memosOf(tx: ParsedTx): string[] {
  const out: string[] = [];
  for (const ix of tx.transaction.message.instructions ?? []) {
    if (!MEMO_PROGRAMS.has(ix.programId)) continue;
    if (typeof ix.parsed === "string") out.push(ix.parsed);
    else if (typeof ix.data === "string") {
      try {
        out.push(new TextDecoder("utf-8", { fatal: true }).decode(bs58.decode(ix.data)));
      } catch {}
    }
  }
  return out;
}

/** "fuel:<agent-name>" in a memo names the agent a top-up is for. */
export function agentFromMemos(memos: string[]): string | null {
  for (const m of memos) {
    const hit = /^fuel:([a-z0-9-]{3,32})$/.exec(m.trim());
    if (hit) return hit[1];
  }
  return null;
}

export type DepositFinding =
  | { ok: true; wallet: string; asset: "USDC" | "SOL"; amountRaw: bigint; slot: number; memos: string[] }
  | { ok: false; reason: "not_found" | "failed_tx" | "no_deposit" | "unknown_sender" };

/** Reads a finalized transaction and finds what it paid into the deposit wallet, and who paid. */
export async function findDeposit(signature: string, deposit: string): Promise<DepositFinding> {
  const tx = await rpc<ParsedTx | null>("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 1 },
  ]);
  if (!tx || !tx.meta) return { ok: false, reason: "not_found" };
  if (tx.meta.err) return { ok: false, reason: "failed_tx" };

  // USDC first: the deposit wallet's USDC balance went up; the payer is the owner whose USDC went down.
  const usdc = (list?: TokenBalance[]) => (list ?? []).filter((b) => b.mint === USDC_MINT);
  const pre = new Map(usdc(tx.meta.preTokenBalances).map((b) => [b.accountIndex, b]));
  const post = new Map(usdc(tx.meta.postTokenBalances).map((b) => [b.accountIndex, b]));
  const indexes = new Set([...pre.keys(), ...post.keys()]);
  let received = 0n;
  const spenders = new Map<string, bigint>();
  for (const i of indexes) {
    const before = BigInt(pre.get(i)?.uiTokenAmount.amount ?? "0");
    const after = BigInt(post.get(i)?.uiTokenAmount.amount ?? "0");
    const owner = post.get(i)?.owner ?? pre.get(i)?.owner;
    if (!owner) continue;
    const delta = after - before;
    if (owner === deposit && delta > 0n) received += delta;
    if (owner !== deposit && delta < 0n) spenders.set(owner, (spenders.get(owner) ?? 0n) - delta);
  }
  if (received > 0n) {
    const payer = [...spenders.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))[0]?.[0];
    if (!payer) return { ok: false, reason: "unknown_sender" };
    return { ok: true, wallet: payer, asset: "USDC", amountRaw: received, slot: tx.slot, memos: memosOf(tx) };
  }

  // SOL: the deposit wallet's lamports went up; credit the fee payer (first signer).
  const keys = tx.transaction.message.accountKeys;
  const di = keys.findIndex((k) => k.pubkey === deposit);
  if (di >= 0) {
    const delta = BigInt(tx.meta.postBalances[di]) - BigInt(tx.meta.preBalances[di]);
    if (delta > 0n) {
      const payer = keys.find((k) => k.signer)?.pubkey;
      if (!payer || payer === deposit) return { ok: false, reason: "unknown_sender" };
      return { ok: true, wallet: payer, asset: "SOL", amountRaw: delta, slot: tx.slot, memos: memosOf(tx) };
    }
  }
  return { ok: false, reason: "no_deposit" };
}

/** SOL/USD from two sources. Uses the lower one; refuses if they disagree by more than 2%. */
export async function solUsdPrice(): Promise<number> {
  const sources = await Promise.allSettled([
    fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((d) => Number(d?.So11111111111111111111111111111111111111112?.usdPrice)),
    fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(5_000), cache: "no-store" })
      .then((r) => r.json())
      .then((d) => Number(d?.data?.amount)),
  ]);
  const prices = sources
    .map((s) => (s.status === "fulfilled" ? s.value : NaN))
    .filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length === 0) throw new Error("no SOL price available");
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  if (hi / lo > 1.02) throw new Error("SOL price sources disagree");
  return lo;
}

/** Micro-USD to credit for a deposit. USDC 1:1; SOL at price minus buffer. */
export function creditFor(asset: "USDC" | "SOL", amountRaw: bigint, solPrice: number | null): number {
  if (asset === "USDC") return Number(amountRaw); // USDC has 6 decimals = micro-USD
  const sol = Number(amountRaw) / 1e9;
  return Math.floor(sol * (solPrice ?? 0) * (1 - SOL_PRICE_BUFFER) * 1_000_000);
}

/** Finalized transaction signatures that mention `address` (newest first). Used for Solana Pay references. */
export async function signaturesFor(address: string, limit = 20): Promise<{ signature: string; err: unknown }[]> {
  return rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [address, { limit, commitment: "finalized" }]);
}

export type UsdcTransfer =
  | { ok: true; amountRaw: bigint; accountKeys: string[] }
  | { ok: false; reason: "not_found" | "failed_tx" | "no_transfer" };

/** How much USDC a finalized transaction delivered to `recipient` (any of its token accounts). */
export async function usdcReceivedBy(signature: string, recipient: string): Promise<UsdcTransfer> {
  const tx = await rpc<ParsedTx | null>("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 1 },
  ]);
  if (!tx || !tx.meta) return { ok: false, reason: "not_found" };
  if (tx.meta.err) return { ok: false, reason: "failed_tx" };
  const usdc = (list?: TokenBalance[]) => (list ?? []).filter((b) => b.mint === USDC_MINT && b.owner === recipient);
  const pre = new Map(usdc(tx.meta.preTokenBalances).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
  let received = 0n;
  for (const b of usdc(tx.meta.postTokenBalances)) received += BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n);
  if (received <= 0n) return { ok: false, reason: "no_transfer" };
  return { ok: true, amountRaw: received, accountKeys: tx.transaction.message.accountKeys.map((k) => k.pubkey) };
}
