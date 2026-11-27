import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { issueApiKey } from "@/lib/auth";

// Free trial with no wallet: a visitor's browser gets a guest account ("guest:<id>") funded
// from the trial pot, and an API key that runs cheap text models plus the cheapest model of each
// studio feature (pictures, video, 3D, voice), with small per-trial caps on the media ones.
// One trial per computer (device cookie) and per network (IP) every 30 days; Fuel keeps only
// hashes of both.

export const GUEST_PREFIX = "guest:";
export const isGuest = (wallet: string) => wallet.startsWith(GUEST_PREFIX);

/** Most a guest chat job may ask for (keeps one prompt from eating the whole trial). */
export const GUEST_MAX_TOKENS = 1024;
/** Cheapest typical price (USD per 1M tokens, 3:1 in:out, before markup) a guest chat model may have. */
const GUEST_MAX_TYPICAL_PER_M = 1;
/** Media a guest can make: the cheapest model of each studio feature, capped per trial. */
export const GUEST_MEDIA: Record<string, { model: string; label: string; cap: number | null; noun: string }> = {
  image: { model: "black-forest-labs/FLUX.1-schnell", label: "FLUX schnell", cap: null, noun: "pictures" },
  video: { model: "Lightricks/LTX-Video", label: "LTX-Video", cap: 2, noun: "clips" },
  mesh: { model: "microsoft/TRELLIS", label: "TRELLIS", cap: 2, noun: "3D models" },
  speech: { model: "hexgrad/Kokoro-82M", label: "Kokoro", cap: 5, noun: "voice clips" },
  transcription: { model: "openai/whisper", label: "Whisper", cap: 2, noun: "transcriptions" },
};
/** Longest text a guest can turn into speech. */
export const GUEST_SPEECH_CHARS = 500;
/** Endpoints a guest key may call. */
const GUEST_PATHS = [
  /^\/v1\/chat\/completions$/,
  /^\/v1\/images\/generations$/,
  /^\/v1\/videos(\/[^/]+)?$/,
  /^\/v1\/3d(\/[^/]+)?$/,
  /^\/v1\/audio\/(speech|transcriptions)$/,
  /^\/v1\/account$/,
  /^\/v1\/models$/,
];

export function guestPathAllowed(path: string) {
  return GUEST_PATHS.some((re) => re.test(path));
}

/** Whether a guest may run this job. Returns an error message when it can't. */
export function guestModelRefusal(kind: string, model: string, route?: { inPerM: number; outPerM: number }): string | null {
  const signIn = "Sign in with a wallet to use it.";
  const media = GUEST_MEDIA[kind];
  if (media) return model === media.model ? null : `The free trial makes ${media.noun} with ${media.label}. ${signIn}`;
  if (kind !== "chat") return `The free trial doesn't cover this. ${signIn}`;
  if (!route) return null;
  const typical = (route.inPerM * 3 + route.outPerM) / 4;
  return typical <= GUEST_MAX_TYPICAL_PER_M ? null : `'${model}' isn't part of the free trial (it covers models up to $${GUEST_MAX_TYPICAL_PER_M} per 1M tokens). ${signIn}`;
}

/** A guest's per-trial cap for a media kind (counts jobs that didn't fail). */
export async function guestCapRefusal(wallet: string, kind: string): Promise<string | null> {
  const media = GUEST_MEDIA[kind];
  if (!media?.cap) return null;
  const { count } = await supabaseAdmin().from("jobs").select("id", { count: "exact", head: true }).eq("wallet", wallet).eq("kind", kind).neq("status", "failed");
  return (count ?? 0) >= media.cap ? `The free trial includes ${media.cap} ${media.noun}, and they're used. Sign in with a wallet to make more.` : null;
}

function clientIp(req: Request) {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip")?.trim() || "unknown";
}
const hashOf = (kind: string, v: string) => createHash("sha256").update(`fuel-guest:${kind}:${process.env.FUEL_SECRETS_KEY ?? ""}:${v}`).digest("hex");
const ipHash = (req: Request) => hashOf("ip", clientIp(req));

/** The device cookie: a random id this browser keeps for a year (one free trial per computer). */
export const DEVICE_COOKIE = "fuel_device";
export function deviceIdOf(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)fuel_device=([A-Za-z0-9-]{20,64})/);
  return m?.[1] ?? null;
}
export const newDeviceId = () => randomUUID();

export type GuestStart = { ok: true; api_key: string; credits_usd: number } | { ok: false; status: number; code: string; message: string };

const USED = "The free trial was already used on this computer or network. Sign in or create a wallet to keep going.";
const RECENT = (at: string) => Date.now() - Date.parse(at) < 30 * 86_400_000;

/** Starts a guest trial (one per computer and per network every 30 days), or says why it can't. */
export async function startGuestTrial(req: Request, deviceId: string): Promise<GuestStart> {
  const db = supabaseAdmin();
  const hash = ipHash(req);
  const device = hashOf("device", deviceId);
  const { data: prior } = await db.from("guest_trials").select("created_at").or(`ip_hash.eq.${hash},device_hash.eq.${device}`);
  if ((prior ?? []).some((p) => RECENT(p.created_at))) return { ok: false, status: 409, code: "trial_used", message: USED };
  const wallet = `${GUEST_PREFIX}${randomUUID()}`;
  const { data: r, error } = await db.rpc("fuel_faucet_trial", { p_wallet: wallet });
  if (error) return { ok: false, status: 500, code: "server_error", message: "Could not start the trial." };
  if (r === "pot_empty") return { ok: false, status: 409, code: "pot_empty", message: "The free trial is used up for now. Sign in or create a wallet to keep going." };
  if (r !== "ok") return { ok: false, status: 503, code: "disabled", message: "The free trial is switched off." };
  await db.from("guest_trials").delete().eq("device_hash", device); // an expired one from this computer
  await db.from("guest_trials").upsert({ ip_hash: hash, device_hash: device, wallet, created_at: new Date().toISOString() }, { onConflict: "ip_hash" });
  const key = await issueApiKey(wallet, "free trial (guest)");
  const { data: acct } = await db.from("accounts").select("balance_micro").eq("wallet", wallet).single();
  return { ok: true, api_key: key.api_key, credits_usd: Number(acct?.balance_micro ?? 0) / 1e6 };
}
