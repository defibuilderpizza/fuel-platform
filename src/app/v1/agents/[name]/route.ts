import { connection } from "next/server";
import { getAgent } from "@/lib/agents";
import { apiError } from "@/lib/http";

/** Public agent profile: balance, job count, community fuel, top supporters. Never job details. */
export async function GET(_req: Request, ctx: RouteContext<"/v1/agents/[name]">) {
  await connection();
  const { name } = await ctx.params;
  const agent = await getAgent(name.toLowerCase());
  if (!agent) return apiError(404, "not_found", "No agent with that name.");
  return Response.json(agent);
}
