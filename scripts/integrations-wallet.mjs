// Test helper for the integration packages: creates (or removes) a funded test wallet on a dev server.
//   node --env-file=.env.local scripts/integrations-wallet.mjs create <outfile>   → writes a Solana keypair JSON, funds $2
//   node --env-file=.env.local scripts/integrations-wallet.mjs remove <outfile>   → deletes the wallet's rows
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { readFileSync, writeFileSync } from "node:fs";

const [cmd, file] = process.argv.slice(2);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
if (cmd === "create") {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  const wallet = bs58.encode(pub);
  writeFileSync(file, JSON.stringify([...secret, ...pub]), { mode: 0o600 });
  await db.from("accounts").insert({ wallet });
  await db.rpc("fuel_credit_deposit", { p_signature: `integrations-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: 2e6, p_usd_price: null, p_credit: 2e6, p_slot: 0 });
  console.log(`test wallet ${wallet} funded with $2`);
} else if (cmd === "remove") {
  const b = Uint8Array.from(JSON.parse(readFileSync(file, "utf8")));
  const wallet = bs58.encode(b.slice(32, 64));
  for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", wallet);
  await db.from("accounts").delete().eq("wallet", wallet);
  console.log(`test wallet ${wallet} removed`);
}
