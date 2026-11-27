import { connection } from "next/server";
import { videoStatus } from "@/lib/media";

/** A clip's status: in_progress, completed (with a temporary url and the receipt) or failed. */
export async function GET(_req: Request, ctx: RouteContext<"/v1/videos/[id]">) {
  await connection();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: { message: "No such video job.", type: "not_found", code: "not_found" } }, { status: 404 });
  const r = await videoStatus(id);
  return Response.json(r.body, { status: r.status });
}
