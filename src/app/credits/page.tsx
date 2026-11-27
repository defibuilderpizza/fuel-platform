import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Checks, Eyebrow } from "@/components/ui";
import { marketOverview } from "@/lib/credit-market";
import { tiersOverview } from "@/lib/credit-tiers";
import CreditsTrader from "./credits-trader";

export const metadata: Metadata = {
  title: "Compute credits",
  description: "Prepaid compute in four tiers, opening after the Fuel token launch. 1 credit = at least 1M tokens on any model of its tier. Use it within three months, or trade it with others.",
};

const fmt = (n: number | null, dp = 4) => (n === null ? "–" : `$${n.toFixed(dp)}`);

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-7 sm:space-y-10 px-4 py-8 sm:py-14">
      <section className="grid items-end gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4">
          <Eyebrow>Compute credits</Eyebrow>
          <h1 className="text-3xl font-bold tracking-tight sm:text-6xl">Prepay tokens, trade what you don&apos;t use</h1>
          <p className="max-w-xl text-[15px] text-muted sm:text-lg">
            Credits come in four tiers. One credit is at least 1 million tokens on any model of its tier, and the table below shows exactly how many on each model. Your
            jobs use them automatically. Sell the ones you won&apos;t need, or convert them into a cheaper tier.
          </p>
          <p className="inline-flex rounded-full border border-line bg-card px-3 py-1 text-sm font-medium">
            Opens after the Fuel token launch. Prices below are live today.
          </p>
        </div>
        <Checks
          className="rounded-3xl border border-line bg-card p-6"
          items={[
            "1 credit = at least 1M tokens (3:1 input:output) on its tier's models",
            "Jobs on a tier's models use your credits of that tier automatically",
            "Sell unused credits on the market, or convert down a tier",
            "Credits bought in a month expire together, three months after it starts",
          ]}
        />
      </section>
      <Suspense fallback={<div className="h-64 rounded-3xl border border-line bg-card" />}>
        <Tiers />
      </Suspense>
      <Suspense fallback={<div className="h-96 rounded-3xl border border-line bg-card" />}>
        <Market />
      </Suspense>
      <section className="grid gap-4 md:grid-cols-3">
        {[
          ["Agents and teams", "Buy the tier your agent runs on and know exactly how many tokens you have. Set a rule to top up automatically below a minimum, at a price you choose."],
          ["Holders", "Bought more than you need, or the wrong tier? Sell on the market, set a rule to list them before expiry, or convert them into a cheaper tier."],
          ["How it settles", "Trades settle in Fuel balance at once. Credits left when their series expires turn into balance at their tier's price."],
        ].map(([t, b]) => (
          <div key={t} className="lift rounded-2xl border border-line bg-card p-6">
            <p className="font-semibold tracking-tight">{t}</p>
            <p className="mt-2 text-sm text-muted">{b}</p>
          </div>
        ))}
      </section>
    </main>
  );
}

async function Tiers() {
  await connection();
  const tiers = await tiersOverview();
  const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `${Math.round(n / 1e3)}K`);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-bold tracking-tight">What one credit buys</h2>
        <p className="text-xs text-faint">Tokens at a 3:1 input:output mix · prices from live provider rates</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {tiers.map((t) => (
          <div key={t.id} className="rounded-2xl border border-line bg-card p-5">
            <div className="flex items-baseline justify-between">
              <p className="font-semibold tracking-tight">{t.name}</p>
              <p className="text-xl font-bold tabular-nums">{t.price_usd === null ? "–" : `$${t.price_usd.toFixed(t.price_usd < 1 ? 4 : 2)}`}</p>
            </div>
            <p className="mt-1 text-xs text-muted">{t.description}</p>
            <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto border-t border-line pt-3 text-xs">
              {t.models.length === 0 && <li className="text-muted">No models live in this tier yet.</li>}
              {t.models.map((m) => (
                <li key={m.model} className="flex justify-between gap-2">
                  <span className="truncate font-mono text-muted" title={m.model}>
                    {m.model.split("/").pop()}
                  </span>
                  <span className="shrink-0 tabular-nums" title={m.output_tokens_per_credit === null ? `${m.input_tokens_per_credit.toLocaleString("en-US")} tokens` : `${m.input_tokens_per_credit.toLocaleString("en-US")} if all input, ${m.output_tokens_per_credit.toLocaleString("en-US")} if all output`}>
                    {short(m.tokens_per_credit)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

async function Market() {
  await connection();
  const m = await marketOverview();
  return (
    <div className="space-y-6">
      {!m.trading && (
        <p className="rounded-2xl border border-line bg-card px-5 py-3 text-sm text-muted">
          Credits open after the Fuel token launch. Tiers and prices below are live; the order book shows how trading will work.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {m.series.map((s) => (
          <div key={s.series} className="rounded-2xl border border-line bg-card p-5">
            <div className="flex items-baseline justify-between">
              <p className="font-mono text-sm font-medium">{s.series}</p>
              <p className="text-xs text-faint">{s.days_left} days left</p>
            </div>
            <p className="mt-3 text-3xl font-bold tabular-nums tracking-tight">{fmt(s.last_usd ?? s.value_usd)}</p>
            <p className="text-xs text-muted">
              {s.last_usd === null ? "value now (no trades yet)" : "last trade"}
              {s.premium_pct !== null && (
                <span className={s.premium_pct >= 0 ? " text-bad" : " text-ok"}>
                  {" "}
                  · {s.premium_pct > 0 ? "+" : ""}
                  {s.premium_pct}% vs value
                </span>
              )}
            </p>
            <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-xs">
              <div>
                <dt className="text-faint">Value</dt>
                <dd className="font-medium tabular-nums">{fmt(s.value_usd)}</dd>
              </div>
              <div>
                <dt className="text-faint">Bid</dt>
                <dd className="font-medium tabular-nums">{fmt(s.best_bid_usd)}</dd>
              </div>
              <div>
                <dt className="text-faint">Ask</dt>
                <dd className="font-medium tabular-nums">{fmt(s.best_ask_usd)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-[11px] text-faint">
              Expires {s.expires_at.slice(0, 10)} · 24h {s.volume_24h_credits} cr
            </p>
          </div>
        ))}
        {m.series.length === 0 && <p className="text-sm text-muted">No credit series yet: the first one opens with the first purchase.</p>}
      </div>
      <CreditsTrader series={m.series} trading={m.trading} feePct={m.fee_pct} tiers={(await tiersOverview()).map((t) => ({ id: t.id, name: t.name, price_usd: t.price_usd }))} />
    </div>
  );
}
