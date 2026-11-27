import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { canManage, inviteCode, roleIn } from "@/lib/teams";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Create an invite. Body: { role: "agent" | "member" | "admin", uses?: 1–50 }.
 * Agent invites are redeemed by the agent itself (POST /v1/teams/join with its own key).
 * Only the owner can invite admins.
 */
export async function POST(req: Request, ctx: RouteContext<"/v1/teams/[id]/invites">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const role = await roleIn(id, caller.wallet);
  if (!canManage(role)) return apiError(403, "authentication_error", "Only the team's owner or admins can invite.");
  const body = await readJson<{ role?: string; uses?: number }>(req);
  const inviteRole = body?.role;
  if (inviteRole !== "agent" && inviteRole !== "member" && inviteRole !== "admin") return apiError(400, "invalid_request_error", "'role' must be agent, member or admin.");
  if (inviteRole === "admin" && role !== "owner") return apiError(403, "authentication_error", "Only the owner can invite admins.");
  const uses = Number.isInteger(body?.uses) && body!.uses! >= 1 && body!.uses! <= 50 ? body!.uses! : 1;
  const code = inviteCode();
  const { error } = await supabaseAdmin().from("team_invites").insert({ code, team_id: id, role: inviteRole, created_by: caller.wallet, uses_left: uses });
  if (error) return apiError(500, "server_error", "Could not create the invite.");
  return Response.json({ code, role: inviteRole, uses_left: uses, expires_in_days: 7 }, { status: 201 });
}

/** Cancel an invite. Body: { code }. */
export async function DELETE(req: Request, ctx: RouteContext<"/v1/teams/[id]/invites">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  if (!canManage(await roleIn(id, caller.wallet))) return apiError(403, "authentication_error", "Only the team's owner or admins can cancel invites.");
  const body = await readJson<{ code?: string }>(req);
  await supabaseAdmin().from("team_invites").delete().eq("team_id", id).eq("code", String(body?.code ?? ""));
  return Response.json({ cancelled: true });
}
