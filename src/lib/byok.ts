import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/sellers";
import type { Kind, Route } from "@/lib/providers";

// Bring your own key (BYOK): a customer's own OpenAI or Anthropic key. Fuel calls the provider
// with it; the provider bills the customer directly, so Fuel resells nothing. Fuel charges only
// an optional flat per-job fee (FUEL_BYOK_FEE_USD, default 0) for routing, receipts and limits.
// Off unless FUEL_BYOK_PROVIDERS lists the provider (e.g. "openai,anthropic"); turn a provider on
// only once it has confirmed BYOK is fine under its terms.

export const BYOK_SUPPORTED = ["openai", "anthropic"] as const;
export type ByokProvider = (typeof BYOK_SUPPORTED)[number];

export function byokProviders(): ByokProvider[] {
  return (process.env.FUEL_BYOK_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ByokProvider => (BYOK_SUPPORTED as readonly string[]).includes(s));
}

export function byokFeeMicro(): number {
  const v = Number(process.env.FUEL_BYOK_FEE_USD ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) : 0;
}

/** Check a key with the provider before storing it (lists models; costs nothing). */
async function validate(provider: ByokProvider, key: string): Promise<string | null> {
  const res =
    provider === "openai"
      ? await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
      : await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) return "Couldn't reach the provider to check the key. Try again.";
  if (res.status === 401 || res.status === 403) return "The provider rejected this key.";
  if (!res.ok) return `The provider returned HTTP ${res.status} when checking the key.`;
  return null;
}

export async function saveProviderKey(wallet: string, provider: ByokProvider, key: string) {
  const bad = await validate(provider, key);
  if (bad) return { ok: false as const, message: bad };
  const { error } = await supabaseAdmin()
    .from("provider_keys")
    .upsert({ wallet, provider, key_enc: encryptSecret(key), last4: key.slice(-4), created_at: new Date().toISOString() }, { onConflict: "wallet,provider" });
  if (error) return { ok: false as const, message: "Could not save the key." };
  cache.delete(`${wallet}:${provider}`);
  return { ok: true as const };
}

export async function listProviderKeys(wallet: string) {
  const { data } = await supabaseAdmin().from("provider_keys").select("provider, last4, created_at").eq("wallet", wallet);
  return (data ?? []).map((k) => ({ provider: k.provider as ByokProvider, key: `…${k.last4}`, added_at: k.created_at }));
}

export async function deleteProviderKey(wallet: string, provider: ByokProvider) {
  await supabaseAdmin().from("provider_keys").delete().eq("wallet", wallet).eq("provider", provider);
  cache.delete(`${wallet}:${provider}`);
}

const cache = new Map<string, { at: number; key: string | null }>();
async function providerKey(wallet: string, provider: ByokProvider): Promise<string | null> {
  const k = `${wallet}:${provider}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.key;
  const { data } = await supabaseAdmin().from("provider_keys").select("key_enc").eq("wallet", wallet).eq("provider", provider).maybeSingle();
  let key: string | null = null;
  try {
    key = data?.key_enc ? decryptSecret(data.key_enc) : null;
  } catch {}
  cache.set(k, { at: Date.now(), key });
  return key;
}

/**
 * A route that runs `model` on the caller's own provider key, or null. Used only when Fuel has
 * no route of its own for the model: "openai/<id>" or "anthropic/<id>" (Claude ids map to the
 * provider's id via the price table when Fuel knows it).
 */
export async function byokRoute(wallet: string, model: string, kind: Kind): Promise<Route | null> {
  if (kind !== "chat") return null;
  const [prefix, ...rest] = model.split("/");
  const provider = prefix as ByokProvider;
  if (!rest.length || !byokProviders().includes(provider)) return null;
  const key = await providerKey(wallet, provider);
  if (!key) return null;
  const { data: row } = await supabaseAdmin().from("provider_models").select("provider_model_id, context_length").eq("provider", provider).eq("model", model).maybeSingle();
  return {
    provider,
    providerModelId: row?.provider_model_id ?? rest.join("/"),
    baseUrl: provider === "anthropic" ? "anthropic://messages" : "https://api.openai.com/v1",
    apiKey: key,
    inPerM: 0,
    outPerM: 0,
    byok: true,
    context: row?.context_length ?? null,
  };
}
