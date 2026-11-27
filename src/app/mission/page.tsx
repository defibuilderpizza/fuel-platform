import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow } from "@/components/ui";

export const metadata: Metadata = {
  title: "Mission",
  description: "Fuel's mission: be the go-to place to buy AI compute, bring every GPU and provider into one market, and publish the reference price for compute.",
};

const PILLARS = [
  {
    n: "01",
    t: "Every source of compute, one market",
    b: "Hosted providers, independent GPU owners and spare laptops all sell into the same market behind one API. Agents don't pick a provider: Fuel sends each job to the cheapest healthy option and moves it if that option fails.",
  },
  {
    n: "02",
    t: "The reference price for compute",
    b: "The Fuel Compute Index tracks what AI compute costs across every live model, every five minutes, and every point can be recomputed from its inputs. We want it to be the number people check before they buy, sell or plan.",
  },
  {
    n: "03",
    t: "Built for agents that pay their own way",
    b: "An agent pays from its own wallet, from a balance or per request with x402, and sets its own budget. No accounts, cards or people in the loop. On Solana today, with Robinhood Chain next.",
  },
  {
    n: "04",
    t: "A fair deal for the people who run the compute",
    b: "Sellers set their own price and are paid it on every job. Honest work is checked and paid; made-up answers are caught. Good prices and good uptime are what win the work.",
  },
];

const PRINCIPLES = [
  ["Cheapest honest route", "We never route a job to a dearer provider for our own benefit. Our margin is fixed and public."],
  ["Receipts, not promises", "Every job returns a receipt with the provider, tokens, price and time, so anyone can check what they paid for."],
  ["Your content stays yours", "Prompts and responses pass through and are never stored."],
  ["Open numbers", "Prices, the index and the status page come from real jobs and real price lists, and are public."],
];

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-14 px-4 py-8 sm:py-14">
      <section className="max-w-3xl space-y-4">
        <Eyebrow>Mission</Eyebrow>
        <h1 className="text-3xl font-bold tracking-tight sm:text-6xl">The go-to place for AI compute</h1>
        <p className="text-[15px] text-muted sm:text-lg">
          AI agents are starting to work, pay and decide on their own, and every one of them runs on compute. Fuel exists to be where that compute is bought and sold:
          every GPU and provider in one market, the cheapest healthy route for every job, and an open price that tells everyone what compute costs.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {PILLARS.map((p) => (
          <div key={p.n} className="rounded-3xl border border-line bg-card p-5 sm:p-7">
            <p className="font-mono text-xs text-faint">{p.n}</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight">{p.t}</h2>
            <p className="mt-2 text-muted">{p.b}</p>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold tracking-tight">How we work</h2>
        <dl className="grid gap-x-10 gap-y-5 md:grid-cols-2">
          {PRINCIPLES.map(([t, b]) => (
            <div key={t} className="border-t border-line pt-4">
              <dt className="font-semibold">{t}</dt>
              <dd className="mt-1 text-sm text-muted">{b}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-wrap gap-3">
        <Link href="/studio" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white shadow-sm hover:bg-accent-strong">
          Try a prompt free
        </Link>
        <Link href="/market#index" className="rounded-lg px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base btn-2">
          See the Compute Index
        </Link>
        <Link href="/sell" className="rounded-lg px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base btn-2">
          Sell compute
        </Link>
      </section>
    </main>
  );
}
