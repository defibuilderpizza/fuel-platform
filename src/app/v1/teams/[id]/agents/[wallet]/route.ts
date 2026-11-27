import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { usdToMicro } from "@/lib/money";
import { canManage, roleIn } from "@/lib/teams";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseBudget } from "@/lib/budget";

/**
 * Set a team agent's limits or label. Body: { daily_usd?, per_job_usd?, label? } (null removes a
 * limit), or { budget: "at most $2 a day, no job over 5 cents" } to set limits in plain words.
 */
export async function PATCH(req: Request, ctx: RouteContext<"/v1/teams/[id]/agents/[wallet]">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id, wallet } = await ctx.params;
  if (!canManage(await roleIn(id, caller.wallet))) return apiError(403, "authentication_error", "Only the team's owner or admins can change agents.");
  if ((await roleIn(id, wallet)) !== "agent") return apiError(404, "not_found", "That wallet isn't an agent in this team.");
  const body = await readJson<{ daily_usd?: number | null; per_job_usd?: number | null; label?: string | null; budget?: string }>(req);
  if (!body) return apiError(400, "invalid_request_error", "JSON body required.");
  let understood: string | undefined;
  if (typeof body.budget === "string") {
    const p = parseBudget(body.budget);
    if (!p.ok) return apiError(400, "invalid_request_error", p.error, "budget_not_understood");
    Object.assign(body, p.change);
    understood = p.summary;
  }

  const db = supabaseAdmin();
  const limits: Record<string, number | null> = {};
  for (const [field, column] of [["daily_usd", "daily_limit_micro"], ["per_job_usd", "per_job_limit_micro"]] as const) {
    if (!(field in body)) continue;
    const v = body[field];
    if (v === null) limits[column] = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000) limits[column] = usdToMicro(v);
    else return apiError(400, "invalid_request_error", `'${field}' must be a number from 0 to 100000, or null.`);
  }
  if (Object.keys(limits).length) await db.from("accounts").update(limits).eq("wallet", wallet);
  if ("label" in body) {
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 48) || null : null;
    await db.from("team_members").update({ label }).eq("team_id", id).eq("wallet", wallet);
  }
  return Response.json({ updated: true, ...(understood ? { understood } : {}) });
}
