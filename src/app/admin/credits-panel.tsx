"use client";

import { useState } from "react";

// Reserve health for compute credits: what Fuel owes, what it holds, how far prices can rise
// before the reserve runs short, and the controls to change that.

export type CreditsAdmin = {
  config: { enabled: boolean; require_locked_capacity: boolean; promise_share: number; house_market: boolean; house_credit_discount_bps: number; trading_enabled: boolean; trade_fee_bps: number; cap_usd: number; wallet_cap_usd: number; fee_bps: number; premium_max_bps: number; mint_min_coverage: number; redeem_limit_coverage: number; redeem_daily_usd: number; expiry_days: number };
  price: { level: number; at: string; unit_usd: number; stale: boolean } | null;
  markup_pct: number;
  outstanding: { credits: number; holders: number; value_usd: number; cost_to_deliver_usd: number; paid_principal_usd: number };
  reserve_usd: number;
  coverage: number | null;
  effective_coverage: number | null;
  surplus_usd: number;
  expiring_usd: { "7d": number; "30d": number };
  selling: { open: boolean; reason: string };
  trading: { trades_30d: number; volume_30d_usd: number; fees_30d_usd: number; open_orders: number };
  locked: {
    value_usd: number;
    until: string | null;
    backed_usd: number;
    unbacked_usd: number;
    outlives_lock_usd: number;
    backed_pct: number | null;
    items: { kind: "gpu" | "contract"; credit_24h: { mtok: number; usd: number } | null; market_24h: { mtok: number; usd: number } | null; name: string; models: string[]; live: boolean; until: string; cost_hr: number | null; capacity_mtok: number; promised_mtok: number; price_per_mtok: number; value_usd: number }[];
  };
  redeem_limited: boolean;
  premium_bps: number;
  headroom_usd: number;
  topup_to_sell_usd: number;
  stress: { index_up_pct: number; owe_usd: number; backed_usd: number; cost_usd: number; reserve_after_usd: number }[];
  events: { at: string; kind: string; wallet: string | null; units_micro: number | null; usd_micro: number; note: string | null }[];
};

const usd = (n: number, dp = 2) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(dp)}`;
const pc = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);

export default function CreditsPanel({ c, act }: { c: CreditsAdmin; act: (body: Record<string, unknown>) => Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [cap, setCap] = useState(String(c.config.cap_usd));
  const [walletCap, setWalletCap] = useState(String(c.config.wallet_cap_usd));
  const [busy, setBusy] = useState(false);
  const run = async (b: Record<string, unknown>) => {
    setBusy(true);
    try {
      await act(b);
    } finally {
      setBusy(false);
    }
  };

  // Coverage gauge: 0–200%, with the two thresholds marked.
  const eff = c.effective_coverage;
  const g = (r: number) => `${Math.min(100, (r / 2) * 100)}%`;
  const tone = eff === null ? "bg-[#9b9b9b]" : eff >= c.config.mint_min_coverage ? "bg-[#474747]" : eff >= c.config.redeem_limit_coverage ? "bg-amber-500" : "bg-bad";

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Compute credits</p>
          <p className="mt-1 text-sm text-muted">
            1 credit = ${c.price?.unit_usd.toFixed(4) ?? "–"} now (index {c.price?.level.toFixed(2) ?? "–"}). Expire after {c.config.expiry_days} days and are used automatically. Markup {c.markup_pct}%.
          </p>
        </div>
        <span className={`rounded-lg px-3 py-1.5 text-sm font-medium ${c.selling.open ? "bg-ok/10 text-ok" : "bg-black/10 text-muted"}`}>{c.selling.open ? "Selling" : `Not selling: ${c.selling.reason}`}</span>
      </div>

      <div className="rounded-2xl border border-line bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm font-semibold">Locked capacity behind credits</p>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">Sell spare capacity at market rate</span>
            <button
              disabled={busy}
              onClick={() => run({ action: "config", house_market: !c.config.house_market })}
              className={`rounded-md px-2 py-1 font-medium disabled:opacity-50 ${c.config.house_market ? "bg-accent text-white" : "btn-2"}`}
            >
              {c.config.house_market ? "On" : "Off"}
            </button>
            <span className="text-muted">· credit discount on our GPU {c.config.house_credit_discount_bps / 100}%</span>
          </div>
          <p className="text-xs text-muted">
            Promising {Math.round(c.config.promise_share * 100)}% of each GPU&apos;s capacity · sales {c.config.require_locked_capacity ? "capped by it" : "not capped by it"}
          </p>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-4">
          {[
            ["Worth today", usd(c.locked.value_usd), c.locked.until ? `runs until ${c.locked.until.slice(0, 10)}` : "none locked"],
            ["Credits it backs", usd(c.locked.backed_usd), c.locked.backed_pct === null ? "no credits yet" : `${c.locked.backed_pct}% of what's owed`],
            ["Not backed", usd(c.locked.unbacked_usd), "the reserve covers this"],
            ["Outlive the lock", usd(c.locked.outlives_lock_usd), "credits expiring after it ends"],
          ].map(([k, v, h]) => (
            <div key={k}>
              <p className="text-[11px] uppercase tracking-wider text-faint">{k}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{v}</p>
              <p className="text-xs text-muted">{h}</p>
            </div>
          ))}
        </div>
        {c.locked.items.length > 0 ? (
          <ul className="max-h-96 overflow-y-auto pr-1 mt-4 divide-y divide-line border-t border-line text-sm">
            {c.locked.items.map((x, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-5 gap-y-1 py-2.5">
                <span className={`h-2 w-2 rounded-full ${x.live ? "bg-ok" : "bg-bad"}`} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{x.kind === "gpu" ? x.name : "Seller contract"}</span> <span className="font-mono text-xs text-muted">{x.models.join(", ")}</span>
                </span>
                <span className="tabular-nums text-muted">
                  {x.promised_mtok.toLocaleString("en-US")}M promised{x.kind === "gpu" ? ` of ${x.capacity_mtok.toLocaleString("en-US")}M` : ""}
                </span>
                <span className="tabular-nums text-muted">× ${x.price_per_mtok}/1M</span>
                {x.cost_hr !== null && <span className="tabular-nums text-muted">costs {usd(x.cost_hr)}/hr</span>}
                <span className="font-medium tabular-nums">{usd(x.value_usd)}</span>
                {x.credit_24h && x.market_24h && (
                  <span className="w-full pl-7 text-xs text-muted">
                    Last 24 h: credits {x.credit_24h.mtok.toLocaleString("en-US")}M tokens ({usd(x.credit_24h.usd)}) · spare sold to the market{" "}
                    {x.market_24h.mtok.toLocaleString("en-US")}M tokens ({usd(x.market_24h.usd)})
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-muted">Mark a seller listing as Fuel&apos;s own GPU (with locked cost, throughput and end date) to back credits with it.</p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-5 rounded-2xl border border-line bg-card p-5">
          <div className="grid gap-4 sm:grid-cols-4">
            {[
              ["Outstanding", `${c.outstanding.credits.toLocaleString("en-US")} cr`, `${c.outstanding.holders} holder${c.outstanding.holders === 1 ? "" : "s"}`],
              ["Owed if all used now", usd(c.outstanding.value_usd), `cost to deliver ${usd(c.outstanding.cost_to_deliver_usd)}`],
              ["Reserve", usd(c.reserve_usd), `${c.surplus_usd >= 0 ? "surplus" : "short"} ${usd(Math.abs(c.surplus_usd))}`],
              ["Expiring", usd(c.expiring_usd["7d"]), `7 d · ${usd(c.expiring_usd["30d"])} in 30 d`],
            ].map(([k, v, h]) => (
              <div key={k}>
                <p className="text-[11px] uppercase tracking-wider text-faint">{k}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{v}</p>
                <p className="text-xs text-muted">{h}</p>
              </div>
            ))}
          </div>

          <div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">Coverage</span>
              <span className="tabular-nums text-muted">
                <span className="font-semibold text-ink">{pc(eff)}</span> of delivery cost · {pc(c.coverage)} of value
              </span>
            </div>
            <div className="relative mt-2 h-3 rounded-full bg-black/10">
              <div className={`h-3 rounded-full ${tone}`} style={{ width: eff === null ? "0%" : g(eff) }} />
              {[
                [c.config.redeem_limit_coverage, "use limited"],
                [c.config.mint_min_coverage, "sales pause"],
              ].map(([r, l]) => (
                <div key={l as string} className="absolute -top-1 h-5 w-px bg-[#262626]" style={{ left: g(r as number) }}>
                  <span className="absolute left-1 top-5 whitespace-nowrap font-mono text-[10px] text-faint">
                    {pc(r as number)} {l}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-6 text-xs text-muted">
              {eff === null
                ? "No credits outstanding."
                : c.topup_to_sell_usd > 0
                  ? `Add ${usd(c.topup_to_sell_usd)} to the reserve to reopen sales at today's size.`
                  : `Sales stay open until coverage falls below ${pc(c.config.mint_min_coverage)}.`}
              {c.redeem_limited && ` Credit use is limited to ${usd(c.config.redeem_daily_usd)}/day per wallet.`}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-faint">
                <tr>
                  <th className="py-1.5 font-medium">If the index rises</th>
                  <th className="py-1.5 font-medium">Owed</th>
                  <th className="py-1.5 font-medium">Backed by capacity</th>
                  <th className="py-1.5 font-medium">Cost to deliver</th>
                  <th className="py-1.5 text-right font-medium">Reserve after</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {c.stress.map((s) => (
                  <tr key={s.index_up_pct}>
                    <td className="py-2 font-mono text-xs">+{s.index_up_pct}%</td>
                    <td className="py-2 tabular-nums">{usd(s.owe_usd)}</td>
                    <td className="py-2 tabular-nums">{usd(s.backed_usd)}</td>
                    <td className="py-2 tabular-nums">{usd(s.cost_usd)}</td>
                    <td className={`py-2 text-right font-medium tabular-nums ${s.reserve_after_usd < 0 ? "text-bad" : "text-ok"}`}>{usd(s.reserve_after_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-line bg-card p-5">
            <p className="text-sm font-semibold">Reserve</p>
            <p className="mt-1 text-xs text-muted">Record treasury money moved in (+) or out (−). Keep the real USDC in its own wallet and match this number to it.</p>
            <form
              className="mt-3 space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const n = Number(amount);
                if (!Number.isFinite(n) || n === 0) return;
                await run({ action: "reserve", usd: n, note: note || undefined });
                setAmount("");
                setNote("");
              }}
            >
              <div className="flex gap-2">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="USD, e.g. 500" className="w-32 rounded-lg border border-line-strong bg-white/70 px-3 py-1.5 text-sm" />
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (tx link…)" className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white/70 px-3 py-1.5 text-sm" />
              </div>
              <button disabled={busy} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong disabled:opacity-50">
                Record
              </button>
            </form>
          </div>
          <div className="space-y-3 rounded-2xl border border-line bg-card p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Selling</p>
              <button
                disabled={busy}
                onClick={() => run({ action: "config", enabled: !c.config.enabled })}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${c.config.enabled ? "btn-2" : "bg-accent text-white hover:bg-accent-strong"}`}
              >
                {c.config.enabled ? "Switch off" : "Switch on"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="space-y-1">
                <span className="text-faint">Total cap (USD)</span>
                <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" className="w-full rounded-lg border border-line-strong bg-white/70 px-2 py-1.5 text-sm" />
              </label>
              <label className="space-y-1">
                <span className="text-faint">Per wallet (USD)</span>
                <input value={walletCap} onChange={(e) => setWalletCap(e.target.value)} inputMode="decimal" className="w-full rounded-lg border border-line-strong bg-white/70 px-2 py-1.5 text-sm" />
              </label>
            </div>
            <button disabled={busy} onClick={() => run({ action: "config", cap_usd: Number(cap), wallet_cap_usd: Number(walletCap) })} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2 disabled:opacity-50">
              Save caps
            </button>
            <div className="flex items-center justify-between border-t border-line pt-3">
              <p className="text-sm font-semibold">Trading between holders</p>
              <button
                disabled={busy}
                onClick={() => run({ action: "config", trading_enabled: !c.config.trading_enabled })}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${c.config.trading_enabled ? "btn-2" : "bg-accent text-white hover:bg-accent-strong"}`}
              >
                {c.config.trading_enabled ? "Switch off" : "Switch on"}
              </button>
            </div>
            <p className="text-xs text-muted">
              {c.trading.trades_30d} trades in 30 d · {usd(c.trading.volume_30d_usd)} traded · {usd(c.trading.fees_30d_usd, 4)} fees ({c.config.trade_fee_bps / 100}% each side) ·{" "}
              {c.trading.open_orders} open orders
            </p>
            <div className="flex items-center justify-between text-xs">
              <span className="text-faint">Promise of each GPU</span>
              <select
                disabled={busy}
                value={String(c.config.promise_share)}
                onChange={(e) => run({ action: "config", promise_share: Number(e.target.value) })}
                className="rounded-lg border border-line-strong bg-white/70 px-2 py-1 text-sm"
              >
                {[0.25, 0.35, 0.5, 0.67].map((v) => (
                  <option key={v} value={String(v)}>
                    {Math.round(v * 100)}%
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted">
              Fee {c.config.fee_bps / 100}% · risk premium up to {c.config.premium_max_bps / 100}% (now {c.premium_bps / 100}%) · room left {usd(c.headroom_usd)}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
