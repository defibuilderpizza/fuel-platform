import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { createRule, listRules, validateRule } from "@/lib/credit-rules";

/** Your standing credit rules, with when each last ran and what it did. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json({ rules: await listRules(caller.wallet) });
}

/**
 * Add a rule Fuel runs for you every 5 minutes:
 *   { kind: "keep_min", tier, min_credits, target_credits, max_price_usd }
 *     below min_credits of the tier → buy up to target_credits, never above max_price_usd per
 *     credit (fees included): the order book first, then Fuel.
 *   { kind: "sell_before_expiry", tier, days_before, min_price_usd }
 *     days_before a series of the tier expires → list what you hold of it at min_price_usd.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const v = validateRule(await readJson<Record<string, unknown>>(req));
  if ("error" in v) return apiError(400, "invalid_request_error", v.error);
  const r = await createRule(caller.wallet, v.row);
  if (!r.ok) return apiError(409, "invalid_request_error", r.message);
  return Response.json(r.rule, { status: 201 });
}
