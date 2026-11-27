"use client";

import { useCallback, useEffect, useState } from "react";
import { connectWallet, fuelCall, saveKey, signAndSendWithWallet, useFuelKey } from "@/components/fuel-key";

// Trade, buy and use compute credits. The book is per monthly series.

type Level = { price_usd: number; credits: number };
type Book = { series: string; expires_at: string; bids: Level[]; asks: Level[]; trades: { at: string; price_usd: number; credits: number }[] };
type Series = { series: string; tier: string; expires_at: string; days_left: number; value_usd: number | null; best_bid_usd: number | null; best_ask_usd: number | null; last_usd: number | null };
type Mine = { credits: number; value_usd: number | null; tiers: Record<string, number>; series: { series: string; tier: string; credits: number; expires_at: string }[] };
type Orders = {
  orders: { id: string; series: string; side: "buy" | "sell"; price_usd: number; credits: number; open_credits: number; status: string; created_at: string }[];
  trades: { at: string; series: string; side: string; price_usd: number; credits: number; fee_usd: number }[];
};
type Status = { selling: boolean; status: string; fee_pct: number; risk_premium_pct: number; convert_fee_pct: number; yours?: Mine };
type TierLite = { id: string; name: string; price_usd: number | null };
type Rule = {
  id: string;
  kind: "keep_min" | "sell_before_expiry";
  tier: string;
  min_credits?: number;
  target_credits?: number;
  max_price_usd?: number;
  days_before?: number;
  min_price_usd?: number;
  last_run_at: string | null;
  last_result: string | null;
};

const usd = (n: number | null | undefined, dp = 4) => (n === null || n === undefined ? "–" : `$${n.toFixed(dp)}`);
const field = "w-full rounded-lg border border-line-strong bg-white/70 px-3 py-2 text-sm tabular-nums";

export default function CreditsTrader({ series, trading, feePct, tiers }: { series: Series[]; trading: boolean; feePct: number; tiers: TierLite[] }) {
  const key = useFuelKey();
  const [sel, setSel] = useState(series[0]?.series ?? "");
  const [book, setBook] = useState<Book | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [orders, setOrders] = useState<Orders | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("10");
  const [primary, setPrimary] = useState("10");
  const [buyTier, setBuyTier] = useState(tiers.find((t) => t.price_usd !== null)?.id ?? "open");
  const [conv, setConv] = useState({ series: "", to: "", credits: "" });
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [rule, setRule] = useState({ kind: "keep_min" as Rule["kind"], tier: "open", a: "5", b: "20", c: "" });
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const s = series.find((x) => x.series === sel);

  const load = useCallback(async () => {
    if (!sel) return;
    const [b, st] = await Promise.all([fetch(`/v1/credits/market/${sel}`).then((r) => r.json()), key ? fuelCall<Status>(key, "/v1/credits").catch(() => null) : fetch("/v1/credits").then((r) => r.json())]);
    setBook(b);
    setStatus(st);
    if (key) {
      setOrders(await fuelCall<Orders>(key, "/v1/credits/orders").catch(() => null));
      setRules((await fuelCall<{ rules: Rule[] }>(key, "/v1/credits/rules").catch(() => null))?.rules ?? null);
    }
  }, [sel, key]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    const i = setInterval(load, 15_000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [load]);

  const suggested = side === "buy" ? (book?.asks[0]?.price_usd ?? s?.value_usd ?? null) : (book?.bids[0]?.price_usd ?? s?.value_usd ?? null);
  const preview = (() => {
    const p = Number(price || suggested || 0);
    const a = Number(amount);
    if (!(p > 0) || !(a > 0)) return null;
    const gross = p * a;
    const fee = (gross * feePct) / 100;
    return { gross, fee, total: side === "buy" ? gross + fee : gross - fee };
  })();

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ text: await fn() });
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const holding = status?.yours?.series.find((x) => x.series === sel)?.credits ?? 0;
  const [tokens, setTokens] = useState<{ enabled: boolean; network?: "mainnet" | "devnet"; mints?: { series: string; mint: string }[] } | null>(null);
  const [tokenAmt, setTokenAmt] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/v1/credits/tokens").then((r) => r.json()).then(setTokens).catch(() => setTokens(null));
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const mintOf = tokens?.mints?.find((m) => m.series === sel)?.mint;
  const maxDepth = Math.max(1, ...(book?.bids ?? []).map((l) => l.credits), ...(book?.asks ?? []).map((l) => l.credits));

  return (
    <div className="space-y-6">
      {series.length > 1 && (
        <div className="flex flex-wrap gap-1 rounded-lg bg-white/40 p-1 text-sm">
          {series.map((x) => (
            <button key={x.series} onClick={() => setSel(x.series)} className={`rounded-md px-3 py-1.5 ${sel === x.series ? "bg-white/90 font-medium shadow-sm" : "text-muted hover:text-ink"}`}>
              {x.series} · {x.days_left} d left
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Book */}
        <div className="rounded-3xl border border-line bg-card p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold tracking-tight">Order book · {sel || "–"}</p>
            <p className="font-mono text-xs text-faint">
              value now {usd(s?.value_usd)} · expires {s?.expires_at.slice(0, 10) ?? "–"}
            </p>
          </div>
          <div className="mt-5 grid gap-6 sm:grid-cols-2">
            {(["bids", "asks"] as const).map((k) => (
              <div key={k}>
                <div className="flex justify-between text-[11px] uppercase tracking-wider text-faint">
                  <span>{k === "bids" ? "Buyers pay" : "Sellers ask"}</span>
                  <span>credits</span>
                </div>
                <ul className="mt-2 max-h-80 overflow-y-auto pr-1 space-y-1">
                  {(book?.[k] ?? []).length === 0 && <li className="py-3 text-sm text-muted">No {k === "bids" ? "bids" : "offers"} yet.</li>}
                  {(book?.[k] ?? []).map((l) => (
                    <li key={l.price_usd} className="relative overflow-hidden rounded-md px-2 py-1.5 text-sm">
                      <span className={`absolute inset-y-0 ${k === "bids" ? "right-0 bg-ok/10" : "right-0 bg-bad/10"}`} style={{ width: `${(l.credits / maxDepth) * 100}%` }} />
                      <span className="relative flex justify-between font-mono tabular-nums">
                        <button
                          className={`hover:underline ${k === "bids" ? "text-ok" : "text-bad"}`}
                          onClick={() => {
                            setPrice(String(l.price_usd));
                            setSide(k === "bids" ? "sell" : "buy");
                          }}
                        >
                          {usd(l.price_usd)}
                        </button>
                        <span>{l.credits.toLocaleString("en-US")}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-6 border-t border-line pt-4">
            <p className="text-[11px] uppercase tracking-wider text-faint">Recent trades</p>
            {(book?.trades ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-muted">No trades yet in this series.</p>
            ) : (
              <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                {book!.trades.slice(0, 10).map((t, i) => (
                  <li key={i} className="flex justify-between font-mono text-xs tabular-nums text-muted">
                    <span>{t.at.slice(5, 16).replace("T", " ")}</span>
                    <span className="text-ink">{usd(t.price_usd)}</span>
                    <span>{t.credits} cr</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Trade + account */}
        <div className="space-y-4">
          {!key ? (
            <div className="space-y-3 rounded-3xl border border-line bg-card p-6">
              <p className="font-semibold">Sign in to trade</p>
              <p className="text-sm text-muted">Your wallet is your account. Credits and money stay in your Fuel balance.</p>
              <button onClick={() => act(async () => (await connectWallet("credits"), "Signed in."))} className="w-full rounded-lg bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-strong">
                Connect wallet
              </button>
              <div className="flex gap-2">
                <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="or paste a Fuel API key" className={field} />
                <button onClick={() => paste && saveKey(paste.trim())} className="rounded-lg px-3 text-sm font-medium btn-2">
                  Use
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-3xl border border-line bg-card p-6">
                <div className="flex gap-1 rounded-lg bg-white/40 p-1 text-sm">
                  {(["buy", "sell"] as const).map((x) => (
                    <button key={x} onClick={() => setSide(x)} className={`flex-1 rounded-md px-3 py-1.5 capitalize ${side === x ? "bg-white/90 font-medium shadow-sm" : "text-muted hover:text-ink"}`}>
                      {x}
                    </button>
                  ))}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <label className="space-y-1 text-xs">
                    <span className="text-faint">Price per credit (USD)</span>
                    <input className={field} inputMode="decimal" value={price} placeholder={suggested ? String(suggested) : ""} onChange={(e) => setPrice(e.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="text-faint">Credits{side === "sell" ? ` (you hold ${holding})` : ""}</span>
                    <input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </label>
                </div>
                {preview && (
                  <p className="mt-3 text-xs text-muted">
                    {side === "buy" ? "You pay up to" : "You receive about"} <span className="font-semibold text-ink">{usd(preview.total)}</span> ({usd(preview.gross)} {side === "buy" ? "+" : "−"} {feePct}% fee).
                    Matches the best {side === "buy" ? "offers" : "bids"} first; the rest waits on the book.
                  </p>
                )}
                <button
                  disabled={busy || !trading}
                  onClick={() =>
                    act(async () => {
                      const r = await fuelCall<{ filled_credits: number; open_credits: number }>(key, "/v1/credits/orders", {
                        series: sel,
                        side,
                        price_usd: Number(price || suggested),
                        credits: Number(amount),
                      });
                      return r.open_credits > 0 ? `Traded ${r.filled_credits}; ${r.open_credits} waiting on the book.` : `Traded ${r.filled_credits} credits.`;
                    })
                  }
                  className="mt-4 w-full rounded-lg bg-accent px-4 py-2.5 font-medium capitalize text-white hover:bg-accent-strong disabled:opacity-50"
                >
                  {trading ? `${side} credits` : "Trading opens soon"}
                </button>
              </div>

              {tokens?.enabled && key && sel && (
                <div className="space-y-3 rounded-3xl border border-line bg-card p-6">
                  <div className="flex items-baseline justify-between">
                    <p className="font-semibold">Credit tokens</p>
                    <p className="text-xs text-muted">{tokens.network === "devnet" ? "Solana devnet" : "Solana"} · SPL</p>
                  </div>
                  <p className="text-xs text-muted">
                    Move {sel} credits to your wallet as SPL tokens (1 token = 1 credit) to hold or trade anywhere, and deposit them back to use them. Deposit before the series expires: tokens still out at expiry are forfeited.
                    {mintOf && (
                      <>
                        {" "}Mint <span className="font-mono">{mintOf.slice(0, 4)}…{mintOf.slice(-4)}</span>.
                      </>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input className={field} inputMode="decimal" placeholder="Credits" value={tokenAmt} onChange={(e) => setTokenAmt(e.target.value)} />
                    <button
                      disabled={busy || !(Number(tokenAmt) > 0)}
                      onClick={() =>
                        act(async () => {
                          const r = await fuelCall<{ credits: number; pending?: boolean }>(key, "/v1/credits/tokens/withdraw", { series: sel, credits: Number(tokenAmt) });
                          return r.pending ? `Sending ${r.credits} tokens; they'll show in your wallet within minutes.` : `${r.credits} tokens sent to your wallet.`;
                        })
                      }
                      className="shrink-0 rounded-lg px-3 text-sm font-medium btn-2 disabled:opacity-50"
                    >
                      Withdraw as tokens
                    </button>
                    <button
                      disabled={busy || !(Number(tokenAmt) > 0)}
                      onClick={() =>
                        act(async () => {
                          const acct = await fuelCall<{ wallet: string }>(key, "/v1/account");
                          const tx = await fuelCall<{ transaction: string; network: "mainnet" | "devnet" }>(key, "/v1/credits/tokens/deposit-tx", { series: sel, credits: Number(tokenAmt) });
                          const signature = await signAndSendWithWallet(tx.transaction, acct.wallet, tx.network);
                          // The burn needs a moment to confirm before Fuel can read it.
                          for (let i = 0; i < 10; i++) {
                            await new Promise((ok) => setTimeout(ok, 2000));
                            const r = await fetch("/v1/credits/tokens/deposit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ series: sel, signature }) });
                            const j = await r.json();
                            if (r.ok) return `${j.credits} credits back in your account.`;
                            if (r.status !== 404) throw new Error(j?.error?.message ?? "Deposit failed.");
                          }
                          return `Burn sent (${signature.slice(0, 8)}…). If credits don't appear in a minute, submit that signature at /v1/credits/tokens/deposit.`;
                        })
                      }
                      className="shrink-0 rounded-lg px-3 text-sm font-medium btn-2 disabled:opacity-50"
                    >
                      Deposit tokens
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-3 rounded-3xl border border-line bg-card p-6">
                <div className="flex items-baseline justify-between">
                  <p className="font-semibold">Your credits</p>
                  <p className="text-sm tabular-nums">
                    {status?.yours?.credits ?? 0} cr · {usd(status?.yours?.value_usd ?? 0, 2)}
                  </p>
                </div>
                {(status?.yours?.series ?? []).map((x) => (
                  <p key={x.series} className="flex justify-between text-xs text-muted">
                    <span>{x.series}</span>
                    <span>
                      {x.credits} cr · expires {x.expires_at.slice(0, 10)}
                    </span>
                  </p>
                ))}
                <div className="space-y-2 border-t border-line pt-3">
                  <div className="flex gap-2">
                    <select className={field} value={buyTier} onChange={(e) => setBuyTier(e.target.value)}>
                      {tiers.map((t) => (
                        <option key={t.id} value={t.id} disabled={t.price_usd === null}>
                          {t.name} {t.price_usd === null ? "(no live models)" : `· ${usd(t.price_usd)}/cr`}
                        </option>
                      ))}
                    </select>
                    <input className={field} inputMode="decimal" value={primary} onChange={(e) => setPrimary(e.target.value)} />
                  </div>
                  <button
                    disabled={busy || !status?.selling}
                    onClick={() =>
                      act(async () => {
                        const r = await fuelCall<{ paid_usd: number; tokens: { model: string; tokens: number }[] }>(key, "/v1/credits/buy", { tier: buyTier, credits: Number(primary) });
                        const top = r.tokens[0];
                        return `Bought for $${r.paid_usd.toFixed(4)}.${top ? ` That's ${top.tokens.toLocaleString("en-US")} tokens on ${top.model.split("/").pop()} (more on cheaper models in the tier).` : ""}`;
                      })
                    }
                    className="w-full rounded-lg px-3 py-2 text-sm font-medium btn-2 disabled:opacity-50"
                    title={status?.status}
                  >
                    Buy from Fuel
                  </button>
                </div>
                <p className="text-[11px] text-faint">
                  Tier price + {status?.fee_pct ?? 1}% fee{status?.risk_premium_pct ? ` + ${status.risk_premium_pct}% premium` : ""}. Jobs on the tier&apos;s models use these credits automatically.{" "}
                  {status && !status.selling ? status.status + "." : ""}
                </p>
              </div>

              {(status?.yours?.series ?? []).length > 0 && (
                <div className="space-y-3 rounded-3xl border border-line bg-card p-6">
                  <p className="font-semibold">Convert to a cheaper tier</p>
                  <p className="text-xs text-muted">At the tiers&apos; price ratio, minus a {status?.convert_fee_pct ?? 5}% fee. Same expiry.</p>
                  <div className="grid grid-cols-3 gap-2">
                    <select className={field} value={conv.series} onChange={(e) => setConv({ ...conv, series: e.target.value })}>
                      <option value="">From…</option>
                      {(status?.yours?.series ?? []).map((x) => (
                        <option key={x.series} value={x.series}>
                          {x.series} ({x.credits})
                        </option>
                      ))}
                    </select>
                    <select className={field} value={conv.to} onChange={(e) => setConv({ ...conv, to: e.target.value })}>
                      <option value="">To…</option>
                      {tiers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <input className={field} inputMode="decimal" placeholder="Credits" value={conv.credits} onChange={(e) => setConv({ ...conv, credits: e.target.value })} />
                  </div>
                  <button
                    disabled={busy || !conv.series || !conv.to || !(Number(conv.credits) > 0)}
                    onClick={() =>
                      act(async () => {
                        const r = await fuelCall<{ credits_out: number; to_series: string }>(key, "/v1/credits/convert", { series: conv.series, to_tier: conv.to, credits: Number(conv.credits) });
                        return `Converted into ${r.credits_out} credits of ${r.to_series}.`;
                      })
                    }
                    className="w-full rounded-lg px-3 py-2 text-sm font-medium btn-2 disabled:opacity-50"
                  >
                    Convert
                  </button>
                </div>
              )}

              <div className="space-y-3 rounded-3xl border border-line bg-card p-6">
                <p className="font-semibold">Standing rules</p>
                <p className="text-xs text-muted">Fuel checks these every 5 minutes and trades only within your limits.</p>
                {(rules ?? []).map((r) => (
                  <div key={r.id} className="flex items-start justify-between gap-2 text-xs">
                    <div>
                      <p className="font-medium">
                        {r.kind === "keep_min"
                          ? `${r.tier}: below ${r.min_credits}, buy up to ${r.target_credits} at ≤ ${usd(r.max_price_usd)}`
                          : `${r.tier}: ${r.days_before} d before expiry, sell at ≥ ${usd(r.min_price_usd)}`}
                      </p>
                      {r.last_result && <p className="text-faint">{r.last_result}</p>}
                    </div>
                    <button disabled={busy} onClick={() => act(async () => (await fuelCall(key, `/v1/credits/rules/${r.id}`, undefined, "DELETE"), "Rule deleted."))} className="shrink-0 rounded-lg px-2 py-1 btn-2">
                      Delete
                    </button>
                  </div>
                ))}
                <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
                  <select className={field} value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value as Rule["kind"], a: e.target.value === "keep_min" ? "5" : "7", b: e.target.value === "keep_min" ? "20" : "" })}>
                    <option value="keep_min">Keep a minimum</option>
                    <option value="sell_before_expiry">Sell before expiry</option>
                  </select>
                  <select className={field} value={rule.tier} onChange={(e) => setRule({ ...rule, tier: e.target.value })}>
                    {tiers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  {rule.kind === "keep_min" ? (
                    <>
                      <input className={field} inputMode="decimal" placeholder="Min credits" value={rule.a} onChange={(e) => setRule({ ...rule, a: e.target.value })} />
                      <input className={field} inputMode="decimal" placeholder="Top up to" value={rule.b} onChange={(e) => setRule({ ...rule, b: e.target.value })} />
                      <input className={`${field} col-span-2`} inputMode="decimal" placeholder="Max price per credit, fees in (USD)" value={rule.c} onChange={(e) => setRule({ ...rule, c: e.target.value })} />
                    </>
                  ) : (
                    <>
                      <input className={field} inputMode="numeric" placeholder="Days before expiry" value={rule.a} onChange={(e) => setRule({ ...rule, a: e.target.value })} />
                      <input className={field} inputMode="decimal" placeholder="Min price (USD)" value={rule.c} onChange={(e) => setRule({ ...rule, c: e.target.value })} />
                    </>
                  )}
                </div>
                <button
                  disabled={busy || !(Number(rule.c) > 0)}
                  onClick={() =>
                    act(async () => {
                      const body =
                        rule.kind === "keep_min"
                          ? { kind: rule.kind, tier: rule.tier, min_credits: Number(rule.a), target_credits: Number(rule.b), max_price_usd: Number(rule.c) }
                          : { kind: rule.kind, tier: rule.tier, days_before: Number(rule.a), min_price_usd: Number(rule.c) };
                      await fuelCall(key, "/v1/credits/rules", body);
                      return "Rule added. It runs within 5 minutes.";
                    })
                  }
                  className="w-full rounded-lg px-3 py-2 text-sm font-medium btn-2 disabled:opacity-50"
                >
                  Add rule
                </button>
              </div>
            </>
          )}
          {msg && <p className={`rounded-lg px-4 py-3 text-sm ${msg.bad ? "bg-bad/10 text-bad" : "bg-ok/10 text-ok"}`}>{msg.text}</p>}
        </div>
      </div>

      {key && orders && orders.orders.length > 0 && (
        <div className="overflow-hidden rounded-3xl border border-line bg-card">
          <p className="border-b border-line px-6 py-3 text-sm font-semibold">Your orders</p>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto text-sm">
            {orders.orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-6 py-3">
                <span className={`w-10 font-medium capitalize ${o.side === "buy" ? "text-ok" : "text-bad"}`}>{o.side}</span>
                <span className="font-mono text-xs">{o.series}</span>
                <span className="tabular-nums">
                  {o.credits} cr @ {usd(o.price_usd)}
                </span>
                <span className="text-xs text-muted">{o.status === "open" ? `${o.open_credits} open` : o.status}</span>
                <span className="flex-1" />
                {o.status === "open" && (
                  <button
                    disabled={busy}
                    onClick={() => act(async () => (await fuelCall(key, `/v1/credits/orders/${o.id}`, undefined, "DELETE"), "Order cancelled."))}
                    className="rounded-lg px-3 py-1 text-xs font-medium btn-2"
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
