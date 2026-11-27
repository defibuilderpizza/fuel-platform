import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { canManage, roleIn } from "@/lib/teams";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Remove someone (agent or person) from a team, or leave it yourself.
 * Owners/admins can remove agents and members; only the owner removes admins; the owner can't leave.
 * A removed agent keeps its own wallet, balance and keys.
 */
export async function DELETE(req: Request, ctx: RouteContext<"/v1/teams/[id]/members/[wallet]">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id, wallet } = await ctx.params;
  const me = await roleIn(id, caller.wallet);
  const them = await roleIn(id, wallet);
  if (!them) return apiError(404, "not_found", "That wallet isn't in this team.");
  if (them === "owner") return apiError(400, "invalid_request_error", "The owner can't be removed.");
  const self = wallet === caller.wallet;
  const allowed = self || (canManage(me) && (them !== "admin" || me === "owner"));
  if (!allowed) return apiError(403, "authentication_error", "You can't remove that member.");
  await supabaseAdmin().from("team_members").delete().eq("team_id", id).eq("wallet", wallet);
  return Response.json({ removed: wallet });
}
