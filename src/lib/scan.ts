import "server-only";
import { address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { confirmDeposit } from "@/lib/deposits";
import { USDC_MINT, depositWallet } from "@/lib/solana";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Watches Fuel's deposit address (SOL) and its USDC account, and credits every new transfer
// exactly once (deposits are keyed by signature). Needed for payouts nobody confirms, such as
// an agent's linked fee wallet. Manual confirm still works and is just faster.

const MAX_PER_RUN = 500;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

type SigInfo = { signature: string; err: unknown };

export async function watchedAddresses(): Promise<string[]> {
  const deposit = depositWallet();
  if (!deposit) return [];
  const [usdcAccount] = await findAssociatedTokenPda({ owner: address(deposit), mint: address(USDC_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return [deposit, usdcAccount];
}

export async function scanDeposits() {
  const db = supabaseAdmin();
  const summary: { address: string; new: number; credited: number; stoppedEarly?: string }[] = [];
  for (const addr of await watchedAddresses()) {
    const { data: state } = await db.from("deposit_scan_state").select("last_signature").eq("address", addr).maybeSingle();
    const until = state?.last_signature ?? undefined;

    // Newest first from the RPC; page back until the cursor.
    const found: SigInfo[] = [];
    let before: string | undefined;
    while (found.length < MAX_PER_RUN) {
      const page = await rpc<SigInfo[]>("getSignaturesForAddress", [addr, { limit: 100, commitment: "finalized", until, before }]);
      found.push(...page);
      if (page.length < 100) break;
      before = page[page.length - 1].signature;
    }

    // Oldest first, so the cursor only ever moves past work that is done.
    let cursor = until ?? null;
    let credited = 0;
    let stoppedEarly: string | undefined;
    for (const s of found.reverse()) {
      if (!s.err) {
        const r = await confirmDeposit(s.signature);
        if (r.ok && r.status === 201) credited++;
        // Transient failures (RPC, price feed, DB): stop here and retry from this point next run.
        if (!r.ok && r.status >= 500) {
          stoppedEarly = r.code;
          break;
        }
      }
      cursor = s.signature;
    }
    // Record every run (the status page shows how recently the scanner ran), moving the cursor
    // only past work that is done.
    await db.from("deposit_scan_state").upsert({ address: addr, last_signature: cursor, scanned_at: new Date().toISOString() });
    summary.push({ address: addr, new: found.length, credited, ...(stoppedEarly ? { stoppedEarly } : {}) });
  }
  return summary;
}
