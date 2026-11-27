import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Eyebrow } from "@/components/ui";
import { marketRates } from "@/lib/market";
import { markupBps } from "@/lib/money";
import MarketTable from "./market-table";
import BreakEven from "./break-even";
import { PriceChart } from "@/components/art/diagrams";
import IndexChart from "@/components/index-chart";
import { computeIndex } from "@/lib/compute-index";

export const metadata: Metadata = {
  title: "Market",
  description: "Live compute prices on Fuel: what agents pay per 1M tokens, and the price a seller has to beat to win jobs.",
};

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 sm:space-y-12 px-4 py-8 sm:py-14">
      <section className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl space-y-3">
          <Eyebrow>Market</Eyebrow>
          <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Live compute prices</h1>
          <p className="text-[15px] text-muted sm:text-lg">
            Every model on Fuel, every provider&apos;s price. Agents pay the cheapest route plus Fuel&apos;s {markupBps() / 100}%. Sellers win jobs by being the cheapest
            healthy option.
          </p>
        </div>
        <div className="flex gap-3">
          <Link href="/dashboard" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong">
            Buy compute
          </Link>
          <Link href="/sell#apply" className="rounded-lg px-4 py-2 text-sm font-medium btn-2">
            Sell at these prices
          </Link>
        </div>
      </section>

      <Suspense fallback={<div className="h-80 rounded-3xl border border-line bg-card" />}>
        <ComputeIndex />
      </Suspense>

      <Suspense fallback={<div className="h-96 rounded-2xl border border-line bg-card" />}>
        <Rates />
      </Suspense>

      <section id="pricing-help" className="grid items-start gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-4 rounded-2xl border border-line bg-card p-5 sm:p-7">
          <Eyebrow>For sellers</Eyebrow>
          <h2 className="text-2xl font-bold tracking-tight">How to price your compute</h2>
          <ol className="space-y-4 text-sm">
            {[
              ["Find your cost", "Work out what one million tokens costs you to serve: your GPU's hourly cost divided by the tokens it produces in an hour. The calculator does the maths."],
              ["Check the price to beat", "The table's “seller price to beat” is the cheapest live provider. Fuel sends each job to the cheapest healthy option, so you need to be under it to get the work."],
              ["Leave yourself a margin", "Price above your cost and below the market. A few percent under the current low is usually enough to win jobs while it stays profitable."],
              ["Mind input and output", "Output tokens cost more to generate than input tokens cost to read. Most providers charge 2–5× more for output; Fuel ranks routes on a typical 3:1 input:output job."],
              ["Revisit it", "Prices move as providers change theirs. Update your listing any time; it's re-tested and live again in seconds."],
            ].map(([t, b], i) => (
              <li key={t} className="grid grid-cols-[32px_1fr]">
                <span className="font-mono text-faint">0{i + 1}/</span>
                <div>
                  <p className="font-semibold">{t}</p>
                  <p className="mt-0.5 text-muted">{b}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <Suspense fallback={<div className="h-96 rounded-2xl border border-line bg-card" />}>
          <BreakEvenWithRates />
        </Suspense>
      </section>
    </main>
  );
}

async function Rates() {
  await connection();
  const rates = await marketRates();
  // Blended price of a typical 3:1 input:output job, per 1M tokens, cheapest route.
  const chart = rates
    .filter((r) => r.kind === "chat" && r.providers > 0)
    .map((r) => ({ model: r.model, price: (r.agent_price.in * 3 + r.agent_price.out) / 4, sellers: r.sellers }))
    .filter((r) => r.price > 0)
    .sort((a, b) => a.price - b.price);
  return (
    <div className="space-y-5 sm:space-y-8">
      {chart.length > 1 && (
        <div className="hidden rounded-3xl border border-line bg-card p-6 sm:block sm:p-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold tracking-tight">Cheapest price per 1M tokens, by model</p>
            <p className="font-mono text-xs text-faint">what agents pay · typical 3:1 input:output · log scale</p>
          </div>
          <div className="mt-6 overflow-x-auto">
            <div className="mx-auto min-w-[560px] max-w-4xl">
              <PriceChart rows={chart} />
            </div>
          </div>
        </div>
      )}
      <MarketTable rates={rates} />
    </div>
  );
}

async function BreakEvenWithRates() {
  await connection();
  const rates = (await marketRates()).filter((r) => r.providers > 0);
  return <BreakEven rates={rates} />;
}

const pctFmt = (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

async function ComputeIndex() {
  await connection();
  const fci = await computeIndex(30);
  if (!fci.latest) return null;
  const started = fci.started_at ? new Date(fci.started_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : null;
  return (
    <section id="index" className="scroll-mt-24 rounded-3xl border border-line bg-card p-6 sm:p-8">
      <div className="grid gap-8 lg:grid-cols-[0.75fr_1.25fr]">
        <div className="flex flex-col">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Fuel Compute Index</p>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="text-5xl font-bold tabular-nums tracking-tight">{fci.latest.level.toFixed(2)}</span>
            <span className={`text-sm font-medium tabular-nums ${(fci.change_pct["24h"] ?? 0) > 0 ? "text-bad" : (fci.change_pct["24h"] ?? 0) < 0 ? "text-ok" : "text-muted"}`}>
              {pctFmt(fci.change_pct["24h"])} 24h
            </span>
          </div>
          <p className="mt-2 text-sm text-muted">
            What chat compute costs, as one number. Base {fci.base}
            {started ? ` on ${started}` : ""}. Up means compute got more expensive.
          </p>
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 text-sm">
            <div>
              <dt className="text-xs text-faint">Reference price</dt>
              <dd className="font-semibold tabular-nums">${fci.latest.median_usd.toFixed(4)} / 1M</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Models in the index</dt>
              <dd className="font-semibold tabular-nums">{fci.latest.models}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">7 days</dt>
              <dd className="font-semibold tabular-nums">{pctFmt(fci.change_pct["7d"])}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">30 days</dt>
              <dd className="font-semibold tabular-nums">{pctFmt(fci.change_pct["30d"])}</dd>
            </div>
          </dl>
          <details className="group mt-6 text-sm">
            <summary className="cursor-pointer list-none font-medium text-ink">
              <span className="inline-block transition-transform group-open:rotate-90">›</span> How it&apos;s calculated
            </summary>
            <ul className="mt-3 space-y-2 text-muted">
              <li>Every live chat model with at least one provider, priced at its cheapest provider before Fuel&apos;s markup.</li>
              <li>Each model&apos;s price is for a typical job: 3 input tokens per output token, USD per 1M tokens.</li>
              <li>Every 5 minutes the index moves by the average (geometric) price change of models priced both times, so new or retired models never make it jump.</li>
              <li>The reference price is the median model price. Every point stores its inputs, so any step can be recomputed.</li>
            </ul>
            <p className="mt-3 font-mono text-xs text-faint">GET /v1/index?days=30</p>
          </details>
        </div>
        <div className="min-w-0 self-center">
          <IndexChart series={fci.series} />
          {fci.series.length < 12 && <p className="mt-2 text-xs text-faint">The index started recently; the chart fills in as points are recorded every 5 minutes.</p>}
        </div>
      </div>
    </section>
  );
}
