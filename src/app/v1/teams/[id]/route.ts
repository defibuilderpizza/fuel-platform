import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { canView, roleIn, teamOverview } from "@/lib/teams";

/** A team's overview: agents with balance, spend and limits; totals; people; recent receipts across agents. */
export async function GET(req: Request, ctx: RouteContext<"/v1/teams/[id]">) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const role = await roleIn(id, caller.wallet);
  if (!canView(role)) return apiError(404, "not_found", "No such team, or you're not a member.");
  return Response.json(await teamOverview(id, role!));
}
