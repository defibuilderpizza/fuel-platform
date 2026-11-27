import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Hand back a sealed result. Body: { session_id, task_id, result }. */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ session_id?: string; task_id?: string; result?: string }>(req);
  if (typeof body?.session_id !== "string" || typeof body.task_id !== "string" || typeof body.result !== "string" || body.result.length > 2_000_000) {
    return apiError(400, "invalid_request_error", "'session_id', 'task_id' and 'result' are required.");
  }
  const db = supabaseAdmin();
  const { data: s } = await db.from("lane_workers").select("wallet").eq("session_id", body.session_id).maybeSingle();
  if (!s || s.wallet !== caller.wallet) return apiError(404, "not_found", "Unknown session.", "unknown_session");
  const { data } = await db
    .from("lane_tasks")
    .update({ result: body.result, done_at: new Date().toISOString() })
    .eq("id", body.task_id)
    .eq("session_id", body.session_id)
    .not("claimed_at", "is", null)
    .is("result", null)
    .select("id");
  if (!data?.length) return apiError(410, "invalid_request_error", "That task is finished or no longer yours (it may have timed out).", "task_gone");
  await db.from("lane_workers").update({ last_seen: new Date().toISOString() }).eq("session_id", body.session_id);
  return Response.json({ accepted: true });
}
