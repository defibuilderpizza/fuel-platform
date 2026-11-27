import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { accountView, setLimits } from "@/lib/account";

export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json(await accountView(caller.wallet));
}

/** Set spending limits. null removes a limit. Body: { daily_usd?, per_job_usd? } */
export async function PATCH(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ daily_usd?: number | null; per_job_usd?: number | null }>(req);
  if (!body) return apiError(400, "invalid_request_error", "JSON body required.");
  const err = await setLimits(caller.wallet, body);
  if (err) return apiError(err.startsWith("Could not") ? 500 : 400, err.startsWith("Could not") ? "server_error" : "invalid_request_error", err);
  return Response.json(await accountView(caller.wallet));
}
