// Devnet end-to-end test of credit tokens (needs migration 0023). Real devnet transactions.
//   FUEL_CREDIT_MINT_AUTHORITY=<base58 devnet key> FUEL_TEST_HOLDER=<base58 devnet key> \
//   npx tsx --conditions=react-server --env-file=.env.local scripts/credit-tokens-devnet.mts
// Only the authority needs devnet SOL (it sends the holder 0.02 SOL for fees if needed). Creates a throwaway series and holder, then checks:
// withdraw mints tokens, deposit (burn) gives credits back, a burn can't be credited twice,
// over-withdrawal is refused, and tokens minted outside Fuel halt the series. Cleans up its rows.
import "./test-guard.mjs";
import bs58 from "bs58";
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  address,
} from "@solana/kit";
import { createClient } from "@supabase/supabase-js";

process.env.FUEL_CREDIT_TOKENS_ENABLED = "1";
process.env.FUEL_CREDIT_TOKEN_NETWORK = "devnet";
const bridge: any = await import("../src/lib/credit-bridge.ts");
const token: any = await import("../src/lib/credit-token.ts");
const B = bridge.withdrawCredits ? bridge : bridge.default;
const T = token.mintCredits ? token : token.default;
void appendTransactionMessageInstructions;

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const rpc = createSolanaRpc("https://api.devnet.solana.com");
const holderKey = await createKeyPairSignerFromBytes(bs58.decode(process.env.FUEL_TEST_HOLDER ?? ""));
const holder = holderKey.address as string;
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failures++; };
const series = `test-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function tokenBalance(): Promise<number> {
  const { data: m } = await db.from("credit_mints").select("mint").eq("series_id", series).eq("network", "devnet").maybeSingle();
  if (!m) return 0;
  const { value } = await rpc.getTokenAccountsByOwner(address(holder), { mint: address(m.mint) }, { encoding: "jsonParsed" }).send();
  return value.reduce((t: number, a: any) => t + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
}
async function holderCredits(wallet: string) {
  const { data } = await db.from("credit_lots").select("units_left_micro").eq("wallet", wallet).eq("series_id", series).eq("status", "open");
  return (data ?? []).reduce((t, l) => t + Number(l.units_left_micro), 0) / 1e6;
}
async function signAndSend(base64Tx: string) {
  const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(base64Tx, "base64")));
  const signed = await partiallySignTransaction([holderKey.keyPair], tx);
  const sig = getSignatureFromTransaction(signed as any);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed as any), { encoding: "base64" }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return sig as string;
    await sleep(750);
  }
  throw new Error("burn not confirmed");
}
void getBase64Decoder;

// Top up the holder from the authority so only one key needs the faucet.
{
  const { getTransferSolInstruction } = await import("@solana-program/system");
  const { createTransactionMessage, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } = await import("@solana/kit");
  const auth = await createKeyPairSignerFromBytes(bs58.decode(process.env.FUEL_CREDIT_MINT_AUTHORITY ?? ""));
  const { value: bal } = await rpc.getBalance(address(holder)).send();
  if (bal < 10_000_000n) {
    const { value: bh } = await rpc.getLatestBlockhash().send();
    const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(auth, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: auth, destination: address(holder), amount: 20_000_000n })], m));
    const signed = await signTransactionMessageWithSigners(msg);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
    await sleep(3000);
  }
}

try {
  await db.from("credit_series").insert({ id: series, starts_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  await db.from("accounts").upsert({ wallet: holder }, { onConflict: "wallet" });
  await db.rpc("fuel_credit_give_units", { p_wallet: holder, p_series: series, p_units: 5_000_000, p_price_micro: 0, p_paid: 0, p_fee: 0, p_level: 100 });
  check("holder starts with 5 credits", (await holderCredits(holder)) === 5);

  const w = await B.withdrawCredits(holder, series, 2.5);
  check("withdraw 2.5 credits → tokens minted", w.ok && !!w.signature, JSON.stringify(w).slice(0, 160));
  await sleep(2000);
  check("holder: 2.5 credits left, 2.5 tokens in wallet", (await holderCredits(holder)) === 2.5 && (await tokenBalance()) === 2.5, `${await holderCredits(holder)} / ${await tokenBalance()}`);
  check("bridge holds 2.5 = on-chain supply", (await holderCredits("fuel:credit-bridge")) === 2.5 && Number(await T.onchainSupply(series)) === 2_500_000);

  const over = await B.withdrawCredits(holder, series, 10);
  check("can't withdraw more than held", !over.ok && over.code === "not_enough_credits");

  const d = await B.depositTransaction(holder, series, 1);
  check("deposit-tx builds a burn transaction", d.ok && typeof d.transaction === "string");
  const burnSig = await signAndSend(d.transaction);
  const dep = await B.depositCredits(series, burnSig);
  check("burn of 1 token → 1 credit back", dep.ok && dep.credits === 1 && dep.wallet === holder, JSON.stringify(dep).slice(0, 160));
  check("holder 3.5 credits, 1.5 tokens; bridge 1.5 = supply", (await holderCredits(holder)) === 3.5 && (await tokenBalance()) === 1.5 && (await holderCredits("fuel:credit-bridge")) === 1.5 && Number(await T.onchainSupply(series)) === 1_500_000);
  const again = await B.depositCredits(series, burnSig);
  check("same burn can't be credited twice", !again.ok && again.code === "already_credited");

  // Tokens minted outside Fuel's books: supply > held → the series stops bridging.
  await T.mintCredits(series, holder, 100_000n, "outside");
  await sleep(1500);
  const halted = await B.withdrawCredits(holder, series, 0.5);
  check("tokens minted outside Fuel halt the series", !halted.ok && halted.code === "bridge_halted", JSON.stringify(halted).slice(0, 120));
  const report = await B.bridgeReport();
  const row = report.series?.find((s: any) => s.series === series);
  check("admin report flags the mismatch", row && row.ok === false && row.onchain_supply === 1.6 && row.held_credits === 1.5, JSON.stringify(row));
} finally {
  await db.from("credit_bridge").delete().eq("series_id", series);
  await db.from("credit_events").delete().eq("note", series);
  await db.from("credit_lots").delete().eq("series_id", series);
  await db.from("credit_mints").delete().eq("series_id", series);
  await db.from("credit_series").delete().eq("id", series);
  const { data: left } = await db.from("credit_lots").select("id").eq("wallet", holder).limit(1);
  if (!left?.length) {
    await db.from("ledger_entries").delete().eq("wallet", holder);
    await db.from("accounts").delete().eq("wallet", holder);
  }
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
