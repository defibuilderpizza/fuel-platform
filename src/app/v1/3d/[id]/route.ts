import { connection } from "next/server";
import { mediaStatus } from "@/lib/media";

/** A 3D job's status: in_progress, completed (with a temporary GLB url and the receipt) or failed. */
export async function GET(_req: Request, ctx: RouteContext<"/v1/3d/[id]">) {
  await connection();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: { message: "No such 3D job.", type: "not_found", code: "not_found" } }, { status: 404 });
  const r = await mediaStatus(id, "mesh");
  return Response.json(r.body, { status: r.status });
}
