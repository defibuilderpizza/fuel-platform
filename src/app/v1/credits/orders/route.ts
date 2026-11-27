import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { myOrders, placeOrder } from "@/lib/credit-market";
import { SERIES_RE } from "@/lib/credit-tiers";

/** Your credit orders and trades. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json(await myOrders(caller.wallet));
}

/**
 * Place a limit order. Body: { series, side: "buy" | "sell", price_usd (per credit), credits }.
 * It trades at once against matching orders (best price first, at their price); whatever is
 * left stays on the book. Sells hold your credits; buys hold price × credits + fee.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const b = await readJson<{ series?: unknown; side?: unknown; price_usd?: unknown; credits?: unknown }>(req);
  const series = typeof b?.series === "string" ? b.series : "";
  const side = typeof b?.side === "string" ? b.side : "";
  const price = typeof b?.price_usd === "number" ? b.price_usd : NaN;
  const credits = typeof b?.credits === "number" ? b.credits : NaN;
  if (!SERIES_RE.test(series)) return apiError(400, "invalid_request_error", "'series' looks like 2026-12-pro (month and tier; see GET /v1/credits/market).");
  if (!Number.isFinite(price) || price <= 0 || price > 1000) return apiError(400, "invalid_request_error", "'price_usd' must be above 0 (USD per credit).");
  if (!Number.isFinite(credits) || credits < 0.01 || credits > 1_000_000) return apiError(400, "invalid_request_error", "'credits' must be at least 0.01.");
  const r = await placeOrder(caller.wallet, series, side, price, credits);
  if (!r.ok) return apiError(r.code === "server_error" ? 500 : r.code === "insufficient_balance" ? 402 : 409, "invalid_request_error", r.message, r.code);
  return Response.json(r, { status: 201 });
}
