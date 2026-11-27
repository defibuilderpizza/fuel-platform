// Tiered credits, end to end, against a dev server started with FUEL_ENABLE_MOCK=1 (needs migration 0024):
//   node --env-file=.env.local scripts/credit-tiers-test.mjs http://localhost:3000
// Checks tier prices and tokens per credit, buying a tier, jobs paid with credits (balance
// untouched, reserve pays, unused credits come back), opting out, falling back to the balance,
// converting down a tier, and standing rules (auto-buy, sell before expiry). Restores config
// and removes its test data.
import "./test-guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const BASE = process.argv[2] ?? "http://localhost:3000";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const MODEL = "fuel-test/mock-chat";
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const req = (path, { key, method = "GET", body, headers = {} } = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = (body) =>
  fetch(BASE + "/v1/admin/credits", { method: "POST", headers: { "content-type": "application/json", "x-admin-token": process.env.FUEL_ADMIN_TOKEN }, body: JSON.stringify(body) }).then((r) => r.json());
async function newWallet(fund) {
  const sk = ed25519.utils.randomSecretKey();
  const wallet = bs58.encode(ed25519.getPublicKey(sk));
  const n = await (await req("/v1/auth/nonce", { method: "POST", body: { wallet } })).json();
  const { api_key: key } = await (await req("/v1/auth/keys", { method: "POST", body: { wallet, nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), sk)) } })).json();
  await db.rpc("fuel_credit_deposit", { p_signature: `tiers-test-${wallet}`, p_wallet: wallet, p_asset: "USDC", p_amount_raw: fund * 1e6, p_usd_price: null, p_credit: fund * 1e6, p_slot: 0 });
  return { wallet, key };
}
const bal = async (w) => Number((await db.from("accounts").select("balance_micro, held_micro").eq("wallet", w).single()).data.balance_micro);
const reserve = async () => Number((await db.from("credit_config").select("reserve_micro").eq("id", 1).single()).data.reserve_micro);
const units = async (w, tier) => {
  const { data } = await db.from("credit_lots").select("units_left_micro, credit_series!inner(tier)").eq("wallet", w).eq("status", "open").eq("credit_series.tier", tier);
  return (data ?? []).reduce((t, l) => t + Number(l.units_left_micro), 0);
};
const chat = (key, headers) => req("/v1/chat/completions", { key, method: "POST", headers, body: { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hello there" }] } });
const cron = () => fetch(BASE + "/api/cron/ring-scan", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }).then((r) => r.json());

const { data: saved } = await db.from("credit_config").select("*").eq("id", 1).single();
const startedAt = new Date().toISOString();
let A, B;
let restoreExpiry = null;
try {
  await db.from("provider_models").upsert([{ model: MODEL, kind: "chat", provider: "mock", provider_model_id: "ok", input_per_mtok: 0.2, output_per_mtok: 0.6 }], { onConflict: "model,provider" });
  A = await newWallet(30);
  B = await newWallet(30);
  await admin({ action: "config", enabled: true, require_locked_capacity: false, trading_enabled: true, trade_fee_bps: 50, trade_down_fee_bps: 500, cap_usd: 2500, wallet_cap_usd: 250, mint_min_coverage: 1.25 });
  await admin({ action: "reserve", usd: 50, note: "tiers-test" });

  // ── Tiers ──
  const t = await (await req("/v1/credits/tiers")).json();
  const tier = (id) => t.tiers.find((x) => x.id === id);
  check("four tiers listed", ["max", "pro", "open", "lane"].every((id) => tier(id)), t.tiers.map((x) => `${x.id}=$${x.price_usd}`).join(" "));
  const open = tier("open");
  check("open tier has a price and models", open.price_usd > 0 && open.models.length > 0);
  check("dearest model in a tier gets exactly ~1M tokens per credit", Math.abs(open.models[0].tokens_per_credit - 1_000_000) < 2_000, `${open.models[0].model}: ${open.models[0].tokens_per_credit}`);
  check("every model gets at least 1M per credit", t.tiers.every((x) => x.models.every((m) => m.tokens_per_credit >= 999_000)));
  const pro = tier("pro");
  const max = tier("max");
  check("Claude Opus is Max, Sonnet is Pro", max.models.some((m) => /opus|fable/.test(m.model)) && pro.models.some((m) => /sonnet/.test(m.model)) && !pro.models.some((m) => /opus/.test(m.model)));
  check("tiers price in order: max > pro > open", max.price_usd > pro.price_usd && pro.price_usd > open.price_usd);

  // ── Buy ──
  let r = await req("/v1/credits/buy", { key: A.key, method: "POST", body: { credits: 2 } });
  check("buy without tier → 400", r.status === 400);
  const b0 = await bal(A.wallet);
  r = await req("/v1/credits/buy", { key: A.key, method: "POST", body: { tier: "open", credits: 2 } });
  const buy = await r.json();
  check("buy 2 open credits", r.status === 201 && /^\d{4}-\d{2}-open$/.test(buy.series), `${buy.series} $${buy.paid_usd}`);
  check("response says how many tokens they buy", buy.tokens?.length > 0 && buy.tokens[0].tokens >= 1_999_000, JSON.stringify(buy.tokens?.[0]));
  check("paid from balance", b0 - (await bal(A.wallet)) === Math.round(buy.paid_usd * 1e6));

  // ── Job paid with credits ──
  const before = { bal: await bal(A.wallet), units: await units(A.wallet, "open"), res: await reserve() };
  r = await chat(A.key);
  let j = await r.json();
  const after = { bal: await bal(A.wallet), units: await units(A.wallet, "open"), res: await reserve() };
  const charge = Math.round(j.fuel.price_usd * 1e6);
  const expectUnits = Math.ceil((charge * 1e6) / Math.round(open.price_usd * 1e6));
  check("job ran and was paid with open credits", r.status === 200 && j.fuel.paid_with_credits?.tier === "open", JSON.stringify(j.fuel.paid_with_credits));
  check("balance unchanged", after.bal === before.bal, `${before.bal} → ${after.bal}`);
  check("credits used = charge ÷ tier price (unused hold came back)", before.units - after.units === expectUnits && Math.abs(j.fuel.paid_with_credits.credits * 1e6 - expectUnits) < 1, `${before.units - after.units} vs ${expectUnits}`);
  check("reserve paid the job", before.res - after.res === charge, `${before.res - after.res} vs ${charge}`);
  const { data: acct } = await db.from("accounts").select("held_micro").eq("wallet", A.wallet).single();
  check("nothing left held", Number(acct.held_micro) === 0);

  // ── Opt out ──
  const u1 = await units(A.wallet, "open");
  r = await chat(A.key, { "x-fuel-credits": "off" });
  j = await r.json();
  check("x-fuel-credits: off → paid from balance", r.status === 200 && !j.fuel.paid_with_credits && (await units(A.wallet, "open")) === u1 && (await bal(A.wallet)) < after.bal);

  // ── Not enough credits → balance ──
  r = await chat(B.key);
  j = await r.json();
  check("no credits of the tier → paid from balance", r.status === 200 && !j.fuel.paid_with_credits);

  // ── Manual use is gone ──
  r = await req("/v1/credits/use", { key: A.key, method: "POST", body: { credits: 1 } });
  check("POST /credits/use → 410 explaining jobs use credits", r.status === 410);

  // ── Convert down ──
  r = await req("/v1/credits/buy", { key: A.key, method: "POST", body: { tier: "pro", credits: 0.5 } });
  const proBuy = await r.json();
  check("buy 0.5 pro credits", r.status === 201 && proBuy.series.endsWith("-pro"), JSON.stringify(proBuy).slice(0, 120));
  r = await req("/v1/credits/convert", { key: A.key, method: "POST", body: { series: buy.series, to_tier: "pro", credits: 0.5 } });
  check("can't convert up a tier", r.status === 409 && (await r.json()).error.code === "not_cheaper");
  const openBefore = await units(A.wallet, "open");
  r = await req("/v1/credits/convert", { key: A.key, method: "POST", body: { series: proBuy.series, to_tier: "open", credits: 0.5 } });
  const conv = await r.json();
  const expected = 0.5 * (pro.price_usd / open.price_usd) * 0.95;
  check("convert 0.5 pro → open at price ratio minus 5%", r.status === 200 && Math.abs(conv.credits_out - expected) / expected < 0.01 && conv.to_series === buy.series, `${conv.credits_out} vs ${expected.toFixed(4)}`);
  check("converted credits land in the same month's open series", (await units(A.wallet, "open")) - openBefore === Math.round(conv.credits_out * 1e6) && (await units(A.wallet, "pro")) === 0);

  // ── Rules ──
  r = await req("/v1/credits/rules", { key: B.key, method: "POST", body: { kind: "keep_min", tier: "open", min_credits: 1, target_credits: 0.5, max_price_usd: 1 } });
  check("rule with target below min rejected", r.status === 400);
  // A sells 1 open credit cheaply on the book; B's rule should buy it there first, then the rest from Fuel.
  const ask = Math.round(open.price_usd * 0.8 * 1e6) / 1e6;
  r = await req("/v1/credits/orders", { key: A.key, method: "POST", body: { series: buy.series, side: "sell", price_usd: ask, credits: 1 } });
  check("A lists 1 open credit at 80% of value", r.status === 201);
  r = await req("/v1/credits/rules", { key: B.key, method: "POST", body: { kind: "keep_min", tier: "open", min_credits: 1, target_credits: 3, max_price_usd: open.price_usd * 1.2 } });
  const rule = await r.json();
  check("B adds keep_min rule", r.status === 201 && rule.kind === "keep_min");
  const tick = await cron();
  check("cron ran the rules", tick.creditRules?.ran >= 1, JSON.stringify(tick.creditRules));
  const { data: rr } = await db.from("credit_rules").select("last_result").eq("id", rule.id).single();
  check("B bought 1 on the book and 2 from Fuel", (await units(B.wallet, "open")) === 3_000_000, rr.last_result);
  const { data: resting } = await db.from("credit_orders").select("id").eq("wallet", B.wallet).eq("status", "open");
  check("rule left no resting buy order", (resting ?? []).length === 0);
  await cron();
  check("rule does nothing once above min", (await units(B.wallet, "open")) === 3_000_000);

  // sell_before_expiry: pretend the series expires in 3 days
  const { data: ser } = await db.from("credit_series").select("expires_at").eq("id", buy.series).single();
  restoreExpiry = { series: buy.series, expires_at: ser.expires_at };
  await db.from("credit_series").update({ expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString() }).eq("id", buy.series);
  // Only the test wallet's lots: other holders of the series must keep their expiry.
  await db.from("credit_lots").update({ expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString() }).eq("series_id", buy.series).eq("wallet", A.wallet);
  r = await req("/v1/credits/rules", { key: A.key, method: "POST", body: { kind: "sell_before_expiry", tier: "open", days_before: 5, min_price_usd: open.price_usd * 0.5 } });
  check("A adds sell_before_expiry rule", r.status === 201);
  const aHeld = await units(A.wallet, "open");
  await cron();
  const { data: sells } = await db.from("credit_orders").select("units_open").eq("wallet", A.wallet).eq("status", "open").eq("side", "sell");
  check("A's expiring credits are listed for sale", (await units(A.wallet, "open")) < 10_000 && (sells ?? []).reduce((s, o) => s + Number(o.units_open), 0) >= aHeld - 10_000, `${aHeld} held → listed`);
  r = await req("/v1/credits/rules", { key: A.key });
  check("rules list shows what each did", (await r.json()).rules.every((x) => x.last_result));
} catch (e) {
  console.error("ERROR", e);
  failures++;
} finally {
  if (restoreExpiry) await db.from("credit_series").update({ expires_at: restoreExpiry.expires_at }).eq("id", restoreExpiry.series);
  const cfg = { ...saved };
  delete cfg.id;
  await db.from("credit_config").update(cfg).eq("id", 1);
  for (const w of [A?.wallet, B?.wallet].filter(Boolean)) {
    await db.from("credit_rules").delete().eq("wallet", w);
    await db.from("credit_trades").delete().or(`buyer.eq.${w},seller.eq.${w}`);
    await db.from("credit_orders").delete().eq("wallet", w);
    const { data: holds } = await db.from("credit_job_holds").select("job_id").eq("wallet", w);
    for (const h of holds ?? []) await db.from("credit_job_takes").delete().eq("job_id", h.job_id);
    await db.from("credit_job_holds").delete().eq("wallet", w);
    await db.from("credit_lots").delete().eq("wallet", w);
    for (const t of ["ledger_entries", "jobs", "deposits", "api_keys", "auth_nonces"]) await db.from(t).delete().eq("wallet", w);
    await db.from("accounts").delete().eq("wallet", w);
  }
  await db.from("credit_events").delete().gte("at", startedAt);
  await db.from("provider_models").delete().eq("model", MODEL);
  // Series this test created (empty now).
  const { data: ss } = await db.from("credit_series").select("id").gte("starts_at", new Date(Date.now() - 40 * 86_400_000).toISOString());
  for (const s of ss ?? []) {
    const { count } = await db.from("credit_lots").select("id", { count: "exact", head: true }).eq("series_id", s.id);
    if (!count) await db.from("credit_series").delete().eq("id", s.id);
  }
  const { data: c } = await db.from("credit_config").select("enabled, trading_enabled, reserve_micro").eq("id", 1).single();
  console.log(`config restored: ${JSON.stringify(c)}`);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed (test data cleaned up)");
  process.exit(failures ? 1 : 0);
}
