import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Controls Fuel promised the closed-model labs: no Claude/GPT from unsupported or sanctioned
// regions, no service to sanctioned wallets, and suspension on request.

/** Providers whose terms restrict regions. Open-weight routes are not affected. */
const CLOSED_PROVIDERS = new Set(["anthropic", "openai"]);

// Countries neither Anthropic nor OpenAI support, plus comprehensively sanctioned ones.
// Override with FUEL_CLOSED_BLOCKED_COUNTRIES (comma-separated ISO codes).
const DEFAULT_COUNTRIES = "CN,HK,MO,RU,BY,IR,KP,SY,CU";
// Occupied regions of Ukraine (ISO 3166-2): Crimea, Sevastopol, Donetsk, Luhansk.
// Override with FUEL_CLOSED_BLOCKED_REGIONS (e.g. "UA-43,UA-40").
const DEFAULT_REGIONS = "UA-43,UA-40,UA-14,UA-09";

const list = (v: string | undefined, d: string) =>
  new Set((v ?? d).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));

export const isClosedProvider = (provider: string) => CLOSED_PROVIDERS.has(provider);

/** Where the request comes from, from Vercel's geo headers (null locally). */
export function requestPlace(req: Request) {
  const country = req.headers.get("x-vercel-ip-country")?.toUpperCase() || null;
  const region = req.headers.get("x-vercel-ip-country-region")?.toUpperCase() || null;
  return { country, region: country && region ? `${country}-${region}` : null };
}

/** True when closed-model routes must not serve this request. */
export function closedModelsBlocked(req: Request) {
  const { country, region } = requestPlace(req);
  if (country && list(process.env.FUEL_CLOSED_BLOCKED_COUNTRIES, DEFAULT_COUNTRIES).has(country)) return true;
  if (region && list(process.env.FUEL_CLOSED_BLOCKED_REGIONS, DEFAULT_REGIONS).has(region)) return true;
  return false;
}

export async function isSanctioned(wallet: string) {
  const { data } = await supabaseAdmin().from("sanctioned_wallets").select("wallet").eq("wallet", wallet).maybeSingle();
  return !!data;
}

/** Why this wallet may not use Fuel, or null. */
export async function walletRefusal(wallet: string): Promise<string | null> {
  const [{ data: acct }, sanctioned] = await Promise.all([
    supabaseAdmin().from("accounts").select("suspended_at").eq("wallet", wallet).maybeSingle(),
    isSanctioned(wallet),
  ]);
  if (sanctioned) return "This wallet can't use Fuel (sanctions screening).";
  if (acct?.suspended_at) return "This account is suspended. Contact Fuel if you think this is a mistake.";
  return null;
}

export async function setSuspended(wallet: string, suspended: boolean, reason?: string) {
  const { data, error } = await supabaseAdmin()
    .from("accounts")
    .update(suspended ? { suspended_at: new Date().toISOString(), suspended_reason: reason?.slice(0, 500) ?? null } : { suspended_at: null, suspended_reason: null })
    .eq("wallet", wallet)
    .select("wallet, suspended_at, suspended_reason")
    .maybeSingle();
  if (error) throw error;
  return data;
}

const SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";
const SOL_ADDRESS = /Digital Currency Address - SOL ([1-9A-HJ-NP-Za-km-z]{32,44})/g;
/** EVM addresses (listed under ETH, USDT, USDC, ARB…); stored lowercase like EVM accounts. */
const EVM_ADDRESS = /Digital Currency Address - [A-Z0-9]+ (0x[0-9a-fA-F]{40})/g;

/**
 * Pulls Solana and EVM addresses from the OFAC SDN list into sanctioned_wallets and suspends matching
 * accounts. Same logic as scripts/sanctions-sync.mjs. Addresses are only ever added: a delisted
 * address is removed by hand, after checking.
 */
export async function refreshSanctions() {
  const res = await fetch(SDN_URL, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`SDN list: HTTP ${res.status}`);
  const csv = await res.text();
  if (csv.length < 1_000_000) throw new Error(`SDN list looks truncated (${csv.length} bytes)`);
  const found = new Map<string, string | null>();
  for (const line of csv.split(/\r?\n/)) {
    if (!line.includes("Digital Currency Address")) continue;
    const name = line.match(/^\d+,"([^"]*)"/)?.[1] ?? null;
    for (const m of line.matchAll(SOL_ADDRESS)) found.set(m[1], name);
    for (const m of line.matchAll(EVM_ADDRESS)) found.set(m[1].toLowerCase(), name);
  }
  const rows = [...found].map(([wallet, listed_name]) => ({ wallet, listed_name, source: "OFAC SDN" }));
  if (!rows.length) return { listed: 0, suspended: 0 };
  const db = supabaseAdmin();
  const { error } = await db.from("sanctioned_wallets").upsert(rows, { onConflict: "wallet" });
  if (error) throw error;
  const { data: hit, error: e2 } = await db
    .from("accounts")
    .update({ suspended_at: new Date().toISOString(), suspended_reason: "Sanctions screening (OFAC SDN)" })
    .in("wallet", rows.map((r) => r.wallet))
    .is("suspended_at", null)
    .select("wallet");
  if (e2) throw e2;
  return { listed: rows.length, suspended: hit?.length ?? 0 };
}

/** The 5-minute cron calls this; it refreshes once a day (the 03:00–03:04 UTC run). */
export async function dailySanctionsRefresh(now = new Date()) {
  if (now.getUTCHours() !== 3 || now.getUTCMinutes() >= 5) return { ran: false };
  return { ran: true, ...(await refreshSanctions()) };
}
