import { timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import { apiError } from "@/lib/http";
import { scanRing } from "@/lib/ring";
import { scanDeposits } from "@/lib/scan";
import { sellerHealth } from "@/lib/sellers";
import { recordIndexPoint } from "@/lib/compute-index";
import { expireCredits } from "@/lib/credits";
import { forwardsTick } from "@/lib/forwards";
import { dailySanctionsRefresh } from "@/lib/compliance";
import { checkAndAlert, scheduledCanary } from "@/lib/alerts";
import { reconcilePayouts } from "@/lib/payouts";
import { reconcileBridge } from "@/lib/credit-bridge";
import { runCreditRules } from "@/lib/credit-rules";
import { settlePendingVideos } from "@/lib/media";
import { scanUsdgDeposits } from "@/lib/robinhood";

/**
 * Backup path for money nobody confirmed: public deposits (incl. self-fuelling fee payouts)
 * and private ring top-ups. Also re-tests sellers' models (failing ones leave routing, passing
 * ones return, waiting listings get approved) and records a Fuel Compute Index point.
 * Matches approved earnings payouts to their on-chain USDC transfers.
 * Alerts the operator (Telegram bot, or FUEL_ALERT_WEBHOOK_URL) while anything is degraded or down.
 * Runs holders' standing credit rules (auto-buy / sell before expiry).
 * Once a day it also refreshes the sanctions list (OFAC SDN Solana addresses).
 * Called every 5 minutes by Supabase pg_cron.
 */
export async function GET(req: Request) {
  await connection();
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return apiError(401, "authentication_error", "Not allowed.");
  }
  const sellerHealthDone = sellerHealth().catch((e) => ({ error: String((e as Error).message ?? e) }));
  const [deposits, ring, sellers, index, credits, contracts, sanctions, payouts, creditTokens] = await Promise.all([
    scanDeposits().catch((e) => ({ error: String((e as Error).message ?? e).replace(/api-key=[^&\s]+/g, "api-key=…") })),
    scanRing(),
    sellerHealthDone,
    recordIndexPoint().catch((e) => ({ recorded: false, reason: String((e as Error).message ?? e) })),
    expireCredits().catch((e) => ({ expired: 0, error: String((e as Error).message ?? e) })),
    // after seller health, so it sees fresh test results
    sellerHealthDone.then(() => forwardsTick()).catch((e) => ({ error: String((e as Error).message ?? e) })),
    dailySanctionsRefresh().catch((e) => ({ ran: true, error: String((e as Error).message ?? e) })),
    reconcilePayouts().catch((e) => ({ error: String((e as Error).message ?? e).replace(/api-key=[^&\s]+/g, "api-key=…") })),
    reconcileBridge().catch((e) => ({ error: String((e as Error).message ?? e).replace(/api-key=[^&\s]+/g, "api-key=…") })),
  ]);
  // After expiry, so rules see this run's holdings.
  const creditRules = await runCreditRules().catch((e) => ({ ran: 0, error: String((e as Error).message ?? e) }));
  const usdg = await scanUsdgDeposits().catch((e) => ({ error: String((e as Error).message ?? e).slice(0, 200) }));
  const videos = await settlePendingVideos().catch((e) => ({ checked: 0, error: String((e as Error).message ?? e) }));
  // After the scans, so the alert sees this run's results.
  const canary = await scheduledCanary().catch(() => null);
  const alert = await checkAndAlert(canary).catch((e) => ({ sent: false, reason: String((e as Error).message ?? e) }));
  const failed = "error" in deposits || (!ring.ok && ring.reason === "error");
  return Response.json({ deposits, ring, sellers, index, credits, creditRules, videos, usdg, contracts, sanctions, payouts, creditTokens, alert }, { status: failed ? 500 : 200 });
}
