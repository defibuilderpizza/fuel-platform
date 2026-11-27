// x402 pay-per-request, end to end on Solana devnet (needs migration 0025). Real devnet txs.
//
// 1) Setup (once): creates throwaway devnet keys, a 6-decimal test token standing in for USDC,
//    Fuel's receiving account and an agent wallet holding test tokens. Writes the env for the
//    dev server and the test to the file you name:
//      npx tsx --env-file=.env.local scripts/x402-devnet.mts setup <state.env>
// 2) Start the dev server with mocks and that env, then run the checks against it:
//      FUEL_ENABLE_MOCK=1 node --env-file=.env.local --env-file=<state.env> node_modules/.bin/next dev -p 3010
//      npx tsx --env-file=.env.local --env-file=<state.env> scripts/x402-devnet.mts run http://localhost:3010
// Checks: no key → 402 with PAYMENT-REQUIRED; a signed payment settles on devnet, credits the
// agent's wallet and runs the job (PAYMENT-RESPONSE); the same payment can't be used twice;
// underpayment and a wrong recipient are refused. Removes its database rows.
import "./test-guard.mjs";
import { writeFileSync } from "node:fs";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";
import { createClient } from "@supabase/supabase-js";

const RPC = "https://api.devnet.solana.com";
const rpc = createSolanaRpc(RPC);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** A new keypair and its 64-byte secret (base58), so it can be written to the env file. */
const newKey = async () => {
  const seed = ed25519.utils.randomSecretKey();
  const bytes = new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]);
  return { signer: await createKeyPairSignerFromBytes(bytes), secret: bs58.encode(bytes) };
};

async function send(payer: KeyPairSigner, ixs: Instruction[]) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(ixs, m));
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64" }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    if (value[0]?.err) throw new Error(`tx failed: ${JSON.stringify(value[0].err)}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return sig;
    await sleep(700);
  }
  throw new Error("tx not confirmed");
}

async function airdrop(to: Address, lamports: bigint) {
  const sig = await rpc.requestAirdrop(to, lamports as never).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return;
    await sleep(700);
  }
  throw new Error("airdrop not confirmed");
}

async function setup(out: string) {
  // Fuel's x402 fee payer: reuse FUEL_X402_FEE_PAYER if set (fund it from a devnet faucet first).
  const fp = process.env.FUEL_X402_FEE_PAYER
    ? { signer: await createKeyPairSignerFromBytes(bs58.decode(process.env.FUEL_X402_FEE_PAYER)), secret: process.env.FUEL_X402_FEE_PAYER }
    : await newKey();
  const pt = await newKey(); // Fuel's receiving wallet
  const ag = await newKey(); // the paying agent
  const [feePayer, payTo, agent] = [fp.signer, pt.signer, ag.signer];
  const mint = await generateKeyPairSigner();
  const { value: lamports } = await rpc.getBalance(feePayer.address).send();
  if (lamports < 50_000_000n) {
    console.log(`fee payer ${feePayer.address} has ${Number(lamports) / 1e9} SOL; trying the devnet airdrop…`);
    try {
      await airdrop(feePayer.address, 1_000_000_000n);
    } catch {
      console.log(`Airdrop unavailable. Fund ${feePayer.address} with devnet SOL, then rerun setup with FUEL_X402_FEE_PAYER=${fp.secret}`);
      process.exit(1);
    }
  }
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
  const [agentAta] = await findAssociatedTokenPda({ owner: agent.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await send(feePayer, [
    getCreateAccountInstruction({ payer: feePayer, newAccount: mint, lamports: rent, space: getMintSize(), programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: feePayer.address }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: feePayer, owner: payTo.address, mint: mint.address }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: feePayer, owner: agent.address, mint: mint.address }),
    getMintToCheckedInstruction({ mint: mint.address, token: agentAta, mintAuthority: feePayer, amount: 5_000_000n, decimals: 6 }),
  ]);
  writeFileSync(
    out,
    [
      "FUEL_X402_ENABLED=1",
      "FUEL_X402_NETWORK=devnet",
      `FUEL_X402_FEE_PAYER=${fp.secret}`,
      `FUEL_X402_ASSET=${mint.address}`,
      `FUEL_X402_PAY_TO=${payTo.address}`,
      `FUEL_X402_TEST_AGENT=${ag.secret}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  console.log(`ready: test token ${mint.address}, agent ${agent.address} holds 5.00. Env written to ${out}`);
}

/** What an x402 client does: a partially signed TransferChecked to payTo, fee payer = Fuel's. */
async function pay(agent: KeyPairSigner, req: { amount: string; asset: string; payTo: string; extra: { feePayer: string } }, opts: { amount?: bigint; payTo?: string } = {}) {
  const mint = address(req.asset);
  const [from] = await findAssociatedTokenPda({ owner: agent.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [to] = await findAssociatedTokenPda({ owner: address(opts.payTo ?? req.payTo), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const cb = (data: number[]): Instruction => ({ programAddress: address("ComputeBudget111111111111111111111111111111"), data: new Uint8Array(data) });
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(req.extra.feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          cb([2, ...u32(20_000)]),
          cb([3, ...u64(1_000n)]),
          getTransferCheckedInstruction({ source: from, mint, destination: to, authority: agent, amount: opts.amount ?? BigInt(req.amount), decimals: 6 }),
          getAddMemoInstruction({ memo: bs58.encode(crypto.getRandomValues(new Uint8Array(16))) }),
        ],
        m,
      ),
  );
  const tx = await partiallySignTransaction([agent.keyPair], compileTransaction(msg));
  return getBase64EncodedWireTransaction(tx);
}

async function run(base: string) {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const agent = await createKeyPairSignerFromBytes(bs58.decode(process.env.FUEL_X402_TEST_AGENT ?? ""));
  let failures = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    if (!ok) failures++;
  };
  const MODEL = "fuel-test/mock-chat";
  await db.from("provider_models").upsert([{ model: MODEL, kind: "chat", provider: "mock", provider_model_id: "ok", input_per_mtok: 0.2, output_per_mtok: 0.6 }], { onConflict: "model,provider" });
  const body = JSON.stringify({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
  const call = (headers: Record<string, string> = {}) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const sigHeader = (tx: string, accepted: unknown) => Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { transaction: tx } })).toString("base64");
  const signatures: string[] = [];
  try {
    let r = await call();
    const pr = JSON.parse(Buffer.from(r.headers.get("payment-required") ?? "", "base64").toString() || "{}");
    const req = pr.accepts?.[0];
    check("no key → 402 with PAYMENT-REQUIRED (x402 v2, exact, devnet)", r.status === 402 && pr.x402Version === 2 && req?.scheme === "exact" && req?.network?.startsWith("solana:Et"), JSON.stringify(req));
    check("asks at least $0.01, fee payer named", Number(req.amount) >= 10_000 && !!req.extra?.feePayer);

    r = await call({ "PAYMENT-SIGNATURE": sigHeader(await pay(agent, req, { amount: BigInt(req.amount) - 1n }), req) });
    check("underpayment refused before anything is sent", r.status === 402 && /insufficient_amount/.test((await r.json()).error.message));

    r = await call({ "PAYMENT-SIGNATURE": sigHeader(await pay(agent, req, { payTo: req.extra.feePayer }), req) });
    check("payment to the wrong account refused", r.status === 402 && /wrong_recipient/.test((await r.json()).error.message));

    const tx = await pay(agent, req);
    r = await call({ "PAYMENT-SIGNATURE": sigHeader(tx, req) });
    const j = await r.json();
    const resp = JSON.parse(Buffer.from(r.headers.get("payment-response") ?? "", "base64").toString() || "{}");
    if (resp.transaction) signatures.push(resp.transaction);
    check("paid request runs the job", r.status === 200 && !!j.fuel?.job_id, JSON.stringify(j.error ?? j.fuel));
    check("PAYMENT-RESPONSE: success, devnet tx, payer = agent", resp.success === true && !!resp.transaction && resp.payer === agent.address, JSON.stringify(resp));
    const { data: acct } = await db.from("accounts").select("balance_micro").eq("wallet", agent.address).single();
    check("unused payment stays in the agent's Fuel balance", Number(acct?.balance_micro) === Number(req.amount) - Math.round(j.fuel.price_usd * 1e6), `${acct?.balance_micro} left`);
    const { data: claim } = await db.from("x402_payments").select("job_id, amount_micro").eq("signature", resp.transaction).single();
    check("payment linked to its job", claim?.job_id === j.fuel.job_id && Number(claim?.amount_micro) === Number(req.amount));

    r = await call({ "PAYMENT-SIGNATURE": sigHeader(tx, req) });
    check("the same payment can't pay twice", r.status === 402 && /duplicate_settlement/.test((await r.json()).error.message));

    r = await call({ authorization: "Bearer fuel_sk_nope" });
    check("a bad API key is still a 401 (no x402 offer)", r.status === 401);
  } catch (e) {
    console.error("ERROR", e);
    failures++;
  } finally {
    const w = agent.address as string;
    await db.from("x402_payments").delete().eq("wallet", w);
    for (const t of ["ledger_entries", "jobs", "deposits"]) await db.from(t).delete().eq("wallet", w);
    await db.from("accounts").delete().eq("wallet", w);
    await db.from("provider_models").delete().eq("model", MODEL);
    console.log(failures ? `\n${failures} FAILED` : "\nall passed (test rows removed; devnet txs: " + signatures.join(", ") + ")");
    process.exit(failures ? 1 : 0);
  }
}

const [mode, arg] = process.argv.slice(2);
if (mode === "setup" && arg) await setup(arg);
else if (mode === "run") await run(arg ?? "http://localhost:3010");
else console.log("usage: x402-devnet.mts setup <state.env> | run [baseUrl]");
