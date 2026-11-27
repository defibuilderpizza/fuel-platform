import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { creditState, myCredits } from "@/lib/credits";

/**
 * Compute credits: each tier's price per credit now, whether Fuel is selling, fees, caps and
 * expiry. With an API key, also your credits.
 */
export async function GET(req: Request) {
  await connection();
  const st = await creditState();
  const out = {
    selling: st.selling.open,
    status: st.selling.reason,
    tiers: Object.fromEntries(Object.entries(st.outstanding.by_tier).map(([t, v]) => [t, { price_usd: v.price_usd || null }])),
    fee_pct: st.config.fee_bps / 100,
    risk_premium_pct: st.premium_bps / 100,
    convert_fee_pct: st.config.trade_down_fee_bps / 100,
    expiry_months: st.config.expiry_months,
    wallet_cap_usd: st.config.wallet_cap_usd,
    room_left_usd: st.headroom_usd,
    how_it_works:
      "Credits come in tiers (max, pro, open, lane). 1 credit = at least 1M tokens (3:1 input:output) on any model of its tier; GET /v1/credits/tiers shows the exact tokens per model. Buy from your balance; jobs on a tier's models use your credits of that tier automatically. Sell them on the market, or convert them into a cheaper tier. Credits left at expiry turn into balance at their tier's price.",
  };
  if (req.headers.get("authorization")) {
    const caller = await authenticate(req);
    if (caller instanceof Response) return caller;
    return Response.json({ ...out, yours: await myCredits(caller.wallet) });
  }
  return Response.json(out);
}
