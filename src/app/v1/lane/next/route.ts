import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { nextTask } from "@/lib/lane";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Long-poll for work (~20s). Body: { session_id }. Returns { task } or { task: null }. */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ session_id?: string }>(req);
  if (typeof body?.session_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.session_id)) {
    return apiError(400, "invalid_request_error", "'session_id' is required.");
  }
  const { data: s } = await supabaseAdmin().from("lane_workers").select("wallet").eq("session_id", body.session_id).maybeSingle();
  if (!s || s.wallet !== caller.wallet) return apiError(404, "not_found", "Unknown session. Check in again.", "unknown_session");
  return Response.json({ task: await nextTask(body.session_id) });
}
