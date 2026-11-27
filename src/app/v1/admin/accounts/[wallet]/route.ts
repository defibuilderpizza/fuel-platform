import { requireAdmin } from "@/lib/admin";
import { isWalletAddress } from "@/lib/auth";
import { setSuspended } from "@/lib/compliance";
import { apiError, readJson } from "@/lib/http";

/**
 * Suspend or restore an account. Body: { action: "suspend" | "unsuspend", reason? }.
 * A suspended wallet can't sign in and its API keys stop working on the next request.
 * Use it for Usage Policy breaches and for any suspension a model provider asks for.
 */
export async function POST(req: Request, ctx: RouteContext<"/v1/admin/accounts/[wallet]">) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { wallet } = await ctx.params;
  if (!isWalletAddress(wallet)) return apiError(400, "invalid_request_error", "Not a Solana address.");
  const body = await readJson<{ action?: string; reason?: string }>(req);
  if (body?.action !== "suspend" && body?.action !== "unsuspend") {
    return apiError(400, "invalid_request_error", "'action' must be \"suspend\" or \"unsuspend\".");
  }
  const row = await setSuspended(wallet, body.action === "suspend", body.reason);
  if (!row) return apiError(404, "not_found", "No account for that wallet.");
  return Response.json(row);
}
