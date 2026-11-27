import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { receiptView } from "@/lib/jobs";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** One receipt: price, time, provider. Never content. */
export async function GET(req: Request, ctx: RouteContext<"/v1/jobs/[id]">) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError(404, "not_found", "No such job.");
  const { data } = await supabaseAdmin().from("jobs").select("*").eq("id", id).eq("wallet", caller.wallet).maybeSingle();
  if (!data) return apiError(404, "not_found", "No such job.");
  return Response.json(receiptView(data));
}
