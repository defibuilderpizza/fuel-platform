import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { payoutSummary, requestPayout } from "@/lib/payouts";

/** Your earnings and payouts: what you can withdraw, the minimum, and history. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json(await payoutSummary(caller.wallet));
}

/**
 * Ask for a USDC payout of earnings to your wallet. Body: { amount_usd }.
 * The amount leaves your balance now and is paid after review (usually within a few days).
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ amount_usd?: unknown }>(req);
  const r = await requestPayout(caller.wallet, Number(body?.amount_usd));
  if (!r.ok) return apiError(r.status, r.status === 403 ? "permission_error" : "invalid_request_error", r.message, "code" in r ? r.code : undefined);
  return Response.json({ ...r.payout, note: "Requested. It's paid in USDC to this wallet after review." }, { status: 201 });
}
