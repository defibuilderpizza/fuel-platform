import type { Metadata } from "next";
import Link from "next/link";
import { Checks, Eyebrow, SectionHead } from "@/components/ui";
import { LaptopArt, SellerArt } from "@/components/art/illustrations";
import { MoneyFlow } from "@/components/art/diagrams";
import { markupBps } from "@/lib/money";
import { LANE } from "@/lib/lane";
import SellerApplication from "./seller-application";
import SellerContracts from "./seller-contracts";
import GpuCalculator from "./gpu-calculator";

export const metadata: Metadata = {
  title: "Sell compute",
  description:
    "Sell compute to AI agents on Fuel: run the laptop lane in a browser tab, or list your GPU endpoint.",
};

export default function Page() {
  const share = Math.round(LANE.workerShare * 100);
  return (
    <main className="mx-auto w-full max-w-6xl space-y-14 px-4 py-8 sm:py-14">
      <section className="grid items-center gap-10 md:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          <Eyebrow>For compute sellers</Eyebrow>
          <h1 className="text-3xl font-bold tracking-tight sm:text-6xl">
            Sell compute to AI agents
          </h1>
          <p className="max-w-xl text-[15px] text-muted sm:text-lg">
            Agents on Fuel pay for every job. Fuel sends each job to the
            cheapest compute that can run it, so if your price and uptime are
            good, the work comes to you.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <a
              href="#apply"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white hover:bg-accent-strong"
            >
              List your GPUs
            </a>
            <Link
              href="/market"
              className="rounded-lg px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base btn-2"
            >
              See market prices
            </Link>
          </div>
        </div>
        <div className="art-well hidden place-items-center rounded-3xl p-6 sm:grid">
          <SellerArt className="h-auto w-full max-w-sm" />
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="lift group flex flex-col rounded-3xl border border-line bg-card p-3">
          <div className="art-well grid h-28 place-items-center overflow-hidden p-2 sm:h-52">
            <LaptopArt className="h-full w-full transition-transform duration-500 group-hover:scale-[1.04]" />
          </div>
          <div className="flex flex-1 flex-col p-4 pt-5">
            <p className="font-mono text-xs text-faint">01 / Any laptop</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">
              Laptop lane
            </h2>
            <p className="mt-2 text-muted">
              Open a browser tab and run small embedding jobs. Every result is
              checked against a second laptop; you earn {share}% of the job,
              split between the laptops that agreed.
            </p>
            <Checks
              className="mt-5 flex-1 border-t border-line pt-4"
              items={[
                "No install, runs in a tab",
                "Paid per verified result",
                "Live now",
              ]}
            />
            <Link
              href="/lane"
              className="mt-6 self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white hover:bg-accent-strong"
            >
              Open the laptop lane
            </Link>
          </div>
        </div>
        <div className="lift group flex flex-col rounded-3xl border border-line bg-card p-3">
          <div className="art-well grid h-28 place-items-center overflow-hidden p-2 sm:h-52">
            <SellerArt className="h-full w-full transition-transform duration-500 group-hover:scale-[1.04]" />
          </div>
          <div className="flex flex-1 flex-col p-4 pt-5">
            <p className="font-mono text-xs text-faint">02 / GPU servers</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">
              List your endpoint
            </h2>
            <p className="mt-2 text-muted">
              Run an OpenAI-compatible server (vLLM, SGLang, TGI, Ollama…) and
              set your price per 1M tokens. Once your models pass their tests,
              Fuel routes jobs to you whenever you&apos;re the cheapest healthy
              option.
            </p>
            <Checks
              className="mt-5 flex-1 border-t border-line pt-4"
              items={[
                "You set the price; you're paid it on every job",
                "Tested automatically, live in seconds",
                "Paid in Fuel balance, withdrawable in USDC or USDG",
              ]}
            />
            <a
              href="#apply"
              className="mt-6 self-start rounded-lg px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base btn-2"
            >
              Apply below
            </a>
          </div>
        </div>
      </section>

      <section className="grid items-center gap-8 rounded-3xl border border-line bg-card p-6 sm:p-10 lg:grid-cols-[0.8fr_1.2fr]">
        <SectionHead
          eyebrow="Where the money goes"
          title="You're paid your own price"
          lead={`Fuel adds ${markupBps() / 100}% on top for the agent. Your price is never cut, and you're paid on every job you serve.`}
        />
        <MoneyFlow markupPct={markupBps() / 100} />
      </section>

      <GpuCalculator />

      <section
        id="apply"
        className="grid items-start gap-8 lg:grid-cols-[0.8fr_1.2fr]"
      >
        <div className="space-y-4 self-start rounded-2xl border border-line bg-card p-5 sm:p-7">
          <Eyebrow>GPU endpoint application</Eyebrow>
          <h2 className="text-3xl font-bold tracking-tight">
            How listing works
          </h2>
          <ol className="space-y-4 text-sm">
            {[
              [
                "Apply",
                "Your endpoint's base URL (https, e.g. https://gpu.example.com/v1), an API key for Fuel to use, and the models you serve with your price. The form shows the live price to beat for each model.",
              ],
              [
                "Fuel tests it",
                "Each model gets a real question with a known answer (embeddings: two texts that must differ). You see the result and response time straight away.",
              ],
              [
                "Go live",
                "Models that pass go live straight away. They're re-tested every few minutes: a model that fails drops out of routing and comes back when it passes.",
              ],
              [
                "Get routed",
                "Approved models join Fuel's routing. When you're the cheapest healthy option, jobs go to you. If you fail, jobs move on and you sit out briefly.",
              ],
              [
                "Get paid",
                "Your own listed price for every job you serve, as Fuel balance (withdraw in USDC, minimum $5). Fuel adds its margin on top for the agent.",
              ],
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
          <a
            href="/market#pricing-help"
            className="block rounded-lg border border-line bg-white/60 px-4 py-3 text-sm hover:bg-white/90"
          >
            <span className="font-semibold">Not sure what to charge?</span>{" "}
            <span className="text-muted">
              See live market rates and the break-even calculator →
            </span>
          </a>
          <p className="border-t border-line pt-4 text-xs text-muted">
            Your API key is encrypted before it&apos;s stored and only ever used
            to send jobs to your endpoint. Endpoints must be public https
            addresses.
          </p>
        </div>
        <SellerApplication />
      </section>

      <SellerContracts />
    </main>
  );
}
