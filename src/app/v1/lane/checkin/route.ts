import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { checkin } from "@/lib/lane";
import { LANE_HF_MODEL, LANE_MODEL, unb64 } from "@/lib/lane-crypto";

/** A laptop tab comes online. Body: { pubkey } (the tab's X25519 public key, base64). */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ pubkey?: string }>(req);
  let ok = false;
  try {
    ok = typeof body?.pubkey === "string" && unb64(body.pubkey).length === 32;
  } catch {}
  if (!ok) return apiError(400, "invalid_request_error", "'pubkey' must be a base64 X25519 public key.");
  const session = await checkin(caller.wallet, body!.pubkey!);
  if (!session) return apiError(403, "authentication_error", "This wallet is banned from the laptop lane after failed checks.", "lane_banned");
  return Response.json({ session_id: session, model: LANE_MODEL, hf_model: LANE_HF_MODEL, dtype: "q8", pooling: "cls", normalize: true });
}
