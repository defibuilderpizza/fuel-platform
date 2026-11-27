import { apiError } from "@/lib/http";
import { DEVICE_COOKIE, deviceIdOf, newDeviceId, startGuestTrial } from "@/lib/guest";

/**
 * Free trial with no wallet: returns an API key for a guest account with free credits (cheap
 * text models and FLUX schnell pictures). One per computer and per network every 30 days.
 */
export async function POST(req: Request) {
  const device = deviceIdOf(req) ?? newDeviceId();
  const r = await startGuestTrial(req, device);
  const res = r.ok
    ? Response.json({ api_key: r.api_key, credits_usd: r.credits_usd, note: "Free credits for every studio feature: cheap text models, quick pictures, and a few video, 3D and voice jobs. When they run out, sign in or create a wallet to keep going." }, { status: 201 })
    : apiError(r.status, r.status >= 500 ? "server_error" : "invalid_request_error", r.message, r.code);
  // Remember this computer for a year, whatever happened (so clearing the key doesn't reset it).
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  res.headers.append("Set-Cookie", `${DEVICE_COOKIE}=${device}; Path=/v1/trial; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  return res;
}
