import { randomUUID } from "node:crypto";
import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { usdToMicro } from "@/lib/money";
import { canManage, roleIn } from "@/lib/teams";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Fund a team agent from YOUR balance. Body: { usd }.
 * Top up your own wallet once, then hand it out to your agents. Only your own money moves
 * (never pay-later credit).
 */
export async function POST(req: Request, ctx: RouteContext<"/v1/teams/[id]/agents/[wallet]/fund">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id, wallet } = await ctx.params;
  if (!canManage(await roleIn(id, caller.wallet))) return apiError(403, "authentication_error", "Only the team's owner or admins can fund agents.");
  if ((await roleIn(id, wallet)) !== "agent") return apiError(404, "not_found", "That wallet isn't an agent in this team.");
  if (wallet === caller.wallet) return apiError(400, "invalid_request_error", "That's your own wallet.");
  const body = await readJson<{ usd?: number }>(req);
  const usd = Number(body?.usd);
  if (!Number.isFinite(usd) || usd < 0.01 || usd > 100_000) return apiError(400, "invalid_request_error", "'usd' must be between 0.01 and 100000.");
  const { data: r } = await supabaseAdmin().rpc("fuel_team_transfer", { p_from: caller.wallet, p_to: wallet, p_micro: usdToMicro(usd), p_ref: `team:${id}:${randomUUID()}` });
  if (r === "insufficient_balance") return apiError(402, "insufficient_balance", "Your own balance doesn't cover that. Top up your wallet first.");
  if (r !== "ok") return apiError(500, "server_error", "Could not move the funds.");
  return Response.json({ funded_usd: usd, agent: wallet });
}
