import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { accountView, setLimits } from "@/lib/account";
import { parseBudget } from "@/lib/budget";

/**
 * Set spending limits in plain words. Body: { text, dry_run? }
 *   "at most $5 a day, no job over 10 cents" · "remove the daily limit" · "pause spending"
 * Returns what Fuel understood and the account's limits after the change. With dry_run, nothing
 * is saved. Limits are per UTC day and per job.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const b = await readJson<{ text?: unknown; dry_run?: unknown }>(req);
  if (typeof b?.text !== "string") return apiError(400, "invalid_request_error", "Send { text }, e.g. { \"text\": \"at most $5 a day\" }.");
  const p = parseBudget(b.text);
  if (!p.ok) return apiError(400, "invalid_request_error", p.error, "budget_not_understood");
  if (b.dry_run !== true) {
    const err = await setLimits(caller.wallet, p.change);
    if (err) return apiError(500, "server_error", err);
  }
  const account = await accountView(caller.wallet);
  return Response.json({ understood: p.summary, change: p.change, saved: b.dry_run !== true, limits: account.limits, spent_today_usd: account.spent_today_usd });
}
