import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { cleanAgent, getAgent, listAgents, type AgentInput } from "@/lib/agents";
import { apiError, readJson } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Public directory of agents. ?sort=fuel|jobs|new &limit=50 */
export async function GET(req: Request) {
  await connection();
  const url = new URL(req.url);
  const sort = (["fuel", "jobs", "new"].includes(url.searchParams.get("sort") ?? "") ? url.searchParams.get("sort") : "fuel") as "fuel" | "jobs" | "new";
  return Response.json({ data: await listAgents(sort, Number(url.searchParams.get("limit")) || 50) });
}

/**
 * Register your wallet as a public agent, or update its profile. Permissionless.
 * Body: { name, display_name, description?, x_handle?, website? }. The name is permanent.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<AgentInput>(req);
  if (!body) return apiError(400, "invalid_request_error", "JSON body required.");
  const db = supabaseAdmin();
  const { data: existing } = await db.from("agents").select("name").eq("wallet", caller.wallet).maybeSingle();
  if (existing && body.name !== undefined && body.name === existing.name) delete body.name;
  const clean = cleanAgent(body, !existing);
  if ("error" in clean) return apiError(400, "invalid_request_error", clean.error);

  if (existing) {
    const { error } = await db.from("agents").update({ ...clean.value, updated_at: new Date().toISOString() }).eq("wallet", caller.wallet);
    if (error) return apiError(400, "invalid_request_error", "Could not update the agent.");
    return Response.json(await getAgent(existing.name));
  }
  const { error } = await db.from("agents").insert({ wallet: caller.wallet, ...clean.value });
  if (error) {
    if (error.code === "23505") return apiError(409, "invalid_request_error", `The name '${clean.value.name}' is taken.`, "name_taken");
    return apiError(400, "invalid_request_error", "Could not register the agent.");
  }
  return Response.json(await getAgent(clean.value.name as string), { status: 201 });
}
