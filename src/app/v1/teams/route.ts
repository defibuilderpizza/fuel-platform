import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { myTeams } from "@/lib/teams";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Teams you belong to, with your role in each. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json({ data: await myTeams(caller.wallet) });
}

/** Create a team. Body: { name }. You become its owner. */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ name?: string }>(req);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 48) return apiError(400, "invalid_request_error", "'name' must be 2–48 characters.");
  const db = supabaseAdmin();
  const { data: owned } = await db.from("teams").select("id").eq("owner", caller.wallet);
  if ((owned ?? []).length >= 10) return apiError(400, "invalid_request_error", "You can own up to 10 teams.");
  const { data: t, error } = await db.from("teams").insert({ name, owner: caller.wallet }).select("id, name, created_at").single();
  if (error) return apiError(500, "server_error", "Could not create the team.");
  await db.from("team_members").insert({ team_id: t.id, wallet: caller.wallet, role: "owner" });
  return Response.json({ ...t, role: "owner" }, { status: 201 });
}
