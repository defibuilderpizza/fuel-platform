import { apiError, readJson } from "@/lib/http";
import { confirmUsdgDeposit, RH_CHAIN_ID, USDG_ADDRESS, usdgDepositAddress } from "@/lib/robinhood";

/** How to top up with USDG on Robinhood Chain. */
export async function GET() {
  const to = usdgDepositAddress();
  return Response.json({
    enabled: !!to,
    chain: "Robinhood Chain",
    chain_id: RH_CHAIN_ID,
    asset: { symbol: "USDG", address: USDG_ADDRESS, decimals: 6 },
    deposit_address: to,
    how: "Sign in with your EVM wallet, send USDG on Robinhood Chain to deposit_address from that wallet, then POST { tx_hash } here (Fuel also finds deposits on its own within minutes). 1 USDG = $1 of balance.",
  });
}

/** Confirm a USDG top-up by transaction hash. Body: { tx_hash }. The sending wallet is credited. */
export async function POST(req: Request) {
  const body = await readJson<{ tx_hash?: string }>(req);
  const r = await confirmUsdgDeposit(String(body?.tx_hash ?? ""));
  if (!r.ok) return apiError(r.status, r.status >= 500 ? "not_configured" : "invalid_request_error", r.message, r.code);
  return Response.json(r, { status: r.already_credited ? 200 : 201 });
}
