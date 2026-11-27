import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Join a team with an invite code. Body: { code, label? }.
 * For an agent invite, call this with the AGENT's own API key: that's how the team proves it
 * controls the agent's wallet.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ code?: string; label?: string }>(req);
  const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return apiError(400, "invalid_request_error", "'code' is required.");
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 48) : "";
  const db = supabaseAdmin();
  const { data: r } = await db.rpc("fuel_team_join", { p_code: code, p_wallet: caller.wallet, p_label: label });
  if (r === "bad_code") return apiError(404, "invalid_request_error", "That invite code is unknown, used up or expired.", "bad_code");
  if (r === "already_member") return apiError(409, "invalid_request_error", "This wallet is already in that team.", "already_member");
  if (r === "agent_in_other_team") return apiError(409, "invalid_request_error", "This agent already belongs to another team. Leave it first.", "agent_in_other_team");
  if (r !== "ok") return apiError(500, "server_error", "Could not join the team.");
  const { data: m } = await db.from("team_members").select("team_id, role, teams(name)").eq("wallet", caller.wallet).order("joined_at", { ascending: false }).limit(1).single();
  return Response.json({ team_id: m?.team_id, role: m?.role, team: (m?.teams as unknown as { name: string } | null)?.name ?? null }, { status: 201 });
}
