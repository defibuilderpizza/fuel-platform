// Loads Solana addresses on the OFAC SDN list into sanctioned_wallets and suspends any Fuel
// account that matches. Sanctioned wallets can't sign in and their deposits aren't credited.
//   node --env-file=.env.local scripts/sanctions-sync.mjs [--dry]
// Source: the SDN list published by the US Treasury (sdn.csv). SDN entries carry crypto
// addresses in their remarks as "Digital Currency Address - SOL <address>". Run it regularly.
import { createClient } from "@supabase/supabase-js";

const dry = process.argv.includes("--dry");
const SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";

const res = await fetch(SDN_URL, { redirect: "follow" });
if (!res.ok) throw new Error(`SDN list: HTTP ${res.status}`);
const csv = await res.text();
if (csv.length < 1_000_000) throw new Error(`SDN list looks truncated (${csv.length} bytes); not updating.`);

// Each line: ent_num,"name","type",...,"remarks". Pull the name and every SOL address.
const found = new Map();
for (const line of csv.split(/\r?\n/)) {
  if (!line.includes("Digital Currency Address")) continue;
  const name = (line.match(/^\d+,"([^"]*)"/) ?? [])[1] ?? null;
  for (const m of line.matchAll(/Digital Currency Address - SOL ([1-9A-HJ-NP-Za-km-z]{32,44})/g)) found.set(m[1], name);
  // EVM addresses (ETH, USDT, USDC, ARB…), lowercase like EVM accounts on Fuel.
  for (const m of line.matchAll(/Digital Currency Address - [A-Z0-9]+ (0x[0-9a-fA-F]{40})/g)) found.set(m[1].toLowerCase(), name);
}
console.log(`SDN list: ${found.size} Solana addresses`);
for (const [w, n] of found) console.log(`  ${w}  ${n ?? ""}`);

if (dry) process.exit(0);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const rows = [...found].map(([wallet, listed_name]) => ({ wallet, listed_name, source: "OFAC SDN" }));
if (rows.length) {
  const { error } = await db.from("sanctioned_wallets").upsert(rows, { onConflict: "wallet" });
  if (error) throw error;
  const { data: hit, error: e2 } = await db
    .from("accounts")
    .update({ suspended_at: new Date().toISOString(), suspended_reason: "Sanctions screening (OFAC SDN)" })
    .in("wallet", rows.map((r) => r.wallet))
    .is("suspended_at", null)
    .select("wallet");
  if (e2) throw e2;
  console.log(`saved ${rows.length}; suspended ${hit?.length ?? 0} matching Fuel account(s)`);
}
