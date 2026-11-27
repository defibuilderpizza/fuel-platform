import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { BYOK_SUPPORTED, byokFeeMicro, byokProviders, listProviderKeys, saveProviderKey, type ByokProvider } from "@/lib/byok";
import { microToUsd } from "@/lib/money";

/** Your own provider keys (masked) and which providers accept them right now. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json({
    available: byokProviders(),
    fee_usd_per_job: microToUsd(byokFeeMicro()),
    keys: await listProviderKeys(caller.wallet),
    how: "Add a key, then call models as openai/<model id> or anthropic/<model id>. The provider bills you directly.",
  });
}

/**
 * Add or replace your own key for a provider. Body: { provider: "openai" | "anthropic", api_key }.
 * The key is checked with the provider, encrypted, and never returned.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const b = await readJson<{ provider?: unknown; api_key?: unknown }>(req);
  const provider = typeof b?.provider === "string" ? (b.provider.toLowerCase() as ByokProvider) : null;
  if (!provider || !(BYOK_SUPPORTED as readonly string[]).includes(provider)) return apiError(400, "invalid_request_error", "'provider' must be openai or anthropic.");
  if (!byokProviders().includes(provider)) return apiError(403, "invalid_request_error", `Bring-your-own-key isn't available for ${provider} yet.`, "byok_not_available");
  const key = typeof b?.api_key === "string" ? b.api_key.trim() : "";
  if (key.length < 20 || key.length > 300) return apiError(400, "invalid_request_error", "'api_key' looks wrong.");
  const r = await saveProviderKey(caller.wallet, provider, key);
  if (!r.ok) return apiError(400, "invalid_request_error", r.message, "byok_key_invalid");
  return Response.json({ provider, saved: true, keys: await listProviderKeys(caller.wallet) }, { status: 201 });
}
