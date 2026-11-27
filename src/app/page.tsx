import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { Checks, Eyebrow, SectionHead } from "@/components/ui";
import {
  AgentArt,
  LaptopArt,
  SellerArt,
  TeamArt,
} from "@/components/art/illustrations";
import { JobFlow, LaneVerify } from "@/components/art/diagrams";
import RoutingDiagram from "@/components/home/routing-diagram";
import MarketCards, { cheapestChat } from "@/components/home/market-cards";
import ProductTabs from "@/components/home/product-tabs";
import CodeTabs from "@/components/home/code-tabs";
import { catalogue } from "@/lib/providers";
import { LANE, onlineWorkers } from "@/lib/lane";
import { listAgents } from "@/lib/agents";
import { supabaseAdmin } from "@/lib/supabase/admin";
import TryBox from "@/components/home/try-box";

const BASE =
  (process.env.NEXT_PUBLIC_SITE_URL ?? "https://fuelai.cloud") +
  "/v1";
const sellerShare = Math.round(LANE.workerShare * 100);

const FEATURES: [string, string, string][] = [
  ["x402 pay-per-request", "No account needed: an agent pays each request in USDC or USDG from its own wallet.", "/docs/integrations#x402"],
  ["Agent toolkit", "MCP server, TypeScript SDK and framework plugins, plus llms.txt and OpenAPI.", "/docs/integrations"],
  ["Fuel Compute Index", "What AI compute costs, as one number, updated every five minutes.", "/market#index"],
  ["Sell compute", "List a GPU at your own price, or earn from a laptop in a browser tab.", "/sell"],
];

const audiences = [
  {
    tag: "Agents",
    title: "Buy compute on their own",
    body: "An agent pays from its own wallet: from a balance it tops up, or per request with x402, no account at all. One OpenAI-compatible endpoint, no card, no human in the loop.",
    points: [
      "x402: pay per request in USDC or USDG, no sign-up",
      "Chat, embeddings, classification, pictures, video, 3D",
      "Cheapest provider, automatic failover",
    ],
    cta: { href: "#quickstart", label: "Quickstart" },
    art: AgentArt,
  },
  {
    tag: "Teams running agents",
    title: "Keep control of what they spend",
    body: "Fund your agents in USDC, SOL or USDG, cap what each one can spend, and see a receipt for every job. Give agents a public page so their community can fuel them.",
    points: [
      "One team view for all your agents",
      "Per-agent limits, fund from one wallet",
      "Every receipt in one place",
    ],
    cta: { href: "/teams", label: "Set up a team" },
    art: TeamArt,
  },
  {
    tag: "Compute sellers",
    title: "Get paid for the compute you run",
    body: `Run embedding jobs in a browser tab, or list your GPU endpoint at your own price. Fuel sends work to the cheapest healthy compute, so good prices and uptime win jobs.`,
    points: [
      `Laptop lane: ${sellerShare}% of each verified job`,
      "GPU endpoints: set your price per 1M tokens",
      "Paid in Fuel balance, withdrawable in USDC",
    ],
    cta: { href: "/sell", label: "Start selling" },
    art: SellerArt,
  },
];

export default function Home() {
  return (
    <main className="w-full">
      {/* Hero */}
      <section className="grain relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(55% 60% at 75% 15%, rgba(255,255,255,0.8), transparent 70%)",
          }}
        />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pb-10 pt-8 md:grid-cols-[1fr_1.05fr] md:pb-24 md:pt-20">
          <div className="space-y-4 sm:space-y-6">
            <Eyebrow>The compute market for AI agents</Eyebrow>
            <h1 className="text-[2.05rem] font-bold leading-[1.05] tracking-tight sm:text-6xl">
              Agents buy compute.
              <br />
              <span className="text-faint">Sellers get paid.</span>
            </h1>
            <p className="max-w-lg text-[15px] text-muted sm:text-lg">
              Agents pay in USDC, SOL or USDG, and every job runs on the
              cheapest compute available. Anyone with spare compute can sell
              into the same market.
            </p>
            <div className="flex flex-wrap gap-2 sm:gap-3">
              <Link
                href="/studio"
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white shadow-sm hover:bg-accent-strong"
              >
                Try a prompt free
              </Link>
              <Link
                href="/dashboard"
                className="rounded-lg px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base btn-2"
              >
                Fuel your agents
              </Link>
              <Link href="/sell" className="hidden items-center px-2 text-sm font-medium text-muted underline-offset-4 hover:text-ink hover:underline sm:inline-flex">
                Sell compute →
              </Link>
            </div>
            <p className="text-xs text-muted sm:text-sm">
              Free trial: no wallet, no card.
              <Link href="/sell" className="ml-1.5 underline underline-offset-2 sm:hidden">Sell compute →</Link>
              <span className="hidden sm:inline"> No sign-up.</span>
            </p>
            <Suspense fallback={<div className="h-6" />}>
              <LiveStrip />
            </Suspense>
          </div>
          <div className="hidden md:block">
            <Suspense fallback={<RoutingDiagram />}>
              <HeroDiagram />
            </Suspense>
          </div>
        </div>
      </section>

      {/* Works with */}
      <section className="border-y border-white/60 bg-white/25">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3.5">
          <Link href="/docs/integrations" className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint hover:text-ink">
            Drop-in for
          </Link>
          <div className="-mr-4 flex min-w-0 flex-1 gap-2 overflow-x-auto pr-4 [scrollbar-width:none] sm:mr-0 sm:flex-wrap sm:justify-end sm:overflow-visible sm:pr-0 [&::-webkit-scrollbar]:hidden">
            {[
              ["OpenAI SDK", "/docs/integrations#openai-python"],
              ["Vercel AI SDK", "/docs/integrations#vercel-ai"],
              ["LangChain", "/docs/integrations#langchain"],
              ["CrewAI", "/docs/integrations#crewai"],
              ["MCP", "/docs/integrations#plugins"],
              ["ElizaOS", "/docs/integrations#plugins"],
              ["Solana Agent Kit", "/docs/integrations#plugins"],
              ["curl", "/docs/integrations#curl"],
            ].map(([n, href]) => (
              <Link key={n} href={href} className="shrink-0 rounded-full border border-line bg-white/50 px-3 py-1 font-mono text-xs text-muted transition-colors hover:border-line-strong hover:text-ink">
                {n}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Try it */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-8 sm:pt-12">
        <TryBox />
      </section>

      {/* Audiences */}
      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:py-20">
        <SectionHead eyebrow="Who it's for" title="One market, three sides" />
        <div className="mt-6 grid gap-4 sm:mt-10 sm:gap-5 md:grid-cols-3">
          {audiences.map((a, i) => (
            <div
              key={a.tag}
              className="lift group flex flex-col rounded-3xl border border-line bg-card p-3"
            >
              <div className="art-well grid h-32 place-items-center overflow-hidden px-2 py-2 sm:h-56">
                <a.art className="h-full w-full transition-transform duration-500 group-hover:-translate-y-1 group-hover:scale-[1.04]" />
              </div>
              <div className="flex flex-1 flex-col p-3 pt-4 sm:p-4 sm:pt-5">
                <p className="font-mono text-xs text-faint">
                  0{i + 1} / {a.tag}
                </p>
                <h3 className="mt-1.5 text-lg font-semibold tracking-tight sm:mt-2 sm:text-xl">
                  {a.title}
                </h3>
                <p className="mt-2 text-sm text-muted">{a.body}</p>
                <Checks
                  items={a.points}
                  className="mt-4 flex-1 border-t border-line pt-3 sm:mt-5 sm:pt-4"
                />
                <Link
                  href={a.cta.href}
                  className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-ink sm:mt-6"
                >
                  {a.cta.label}{" "}
                  <span className="transition-transform group-hover:translate-x-1">
                    →
                  </span>
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Core features */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-12 sm:pb-20">
        <SectionHead eyebrow="Features" title="Core features" />
        <div className="mt-5 grid gap-2.5 sm:mt-8 sm:gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(([t, b, href]) => (
            <Link key={t} href={href} className="lift rounded-2xl border border-line bg-card p-4 hover:border-line-strong sm:p-5">
              <p className="font-semibold tracking-tight">{t}</p>
              <p className="mt-1 text-sm text-muted">{b}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* How a job runs */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-12 sm:pb-20">
        <div className="rounded-3xl border border-line bg-card p-5 sm:p-10">
          <SectionHead
            eyebrow="How it works"
            title="From request to receipt in one call"
            lead="Every job follows the same five steps. You only ever pay the exact cost, and if a provider fails mid-job, Fuel moves it."
          />
          <div className="mt-6 sm:mt-10">
            <JobFlow />
          </div>
        </div>
      </section>

      {/* Live market */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-12 sm:pb-20">
        <SectionHead
          eyebrow="Live prices"
          title="What compute costs right now"
          lead="Fuel's price per 1M tokens, cheapest first. Updated from the providers' own price lists."
          aside={
            <Link
              href="/market"
              className="rounded-lg px-4 py-2 text-sm font-medium btn-2"
            >
              Full market →
            </Link>
          }
        />
        <div className="mt-5 sm:mt-8">
          <Suspense
            fallback={
              <div className="h-40 rounded-xl border border-line bg-card" />
            }
          >
            <MarketCards />
          </Suspense>
        </div>
      </section>

      {/* Product tour */}
      <section className="border-y border-line bg-card-2">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:py-16">
          <Eyebrow>Product</Eyebrow>
          <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
            Everything between the job and the compute
          </h2>
          <div className="mt-6 sm:mt-10">
            <ProductTabs />
          </div>
        </div>
      </section>

      {/* Dark band: quickstart */}
      <section id="quickstart" className="bg-[#474747] text-white">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 sm:py-20 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-white/60">
              Quickstart
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
              Live in three steps
            </h2>
            <ol className="mt-6 space-y-4 sm:mt-8 sm:space-y-6">
              {[
                [
                  "Sign in with the agent's wallet",
                  "Sign a one-time message, get an API key. No email.",
                ],
                [
                  "Top up once, or pay per request",
                  "Send USDC or SOL on Solana, or USDG on Robinhood Chain, to your deposit address, or skip it and pay each request with x402. Or claim the free trial credits.",
                ],
                [
                  "Change one line",
                  "Point any OpenAI SDK at Fuel's base URL. Every response carries a receipt.",
                ],
              ].map(([t, b], i) => (
                <li key={t} className="grid grid-cols-[40px_1fr]">
                  <span className="font-mono text-sm text-white/50">
                    0{i + 1}/
                  </span>
                  <div>
                    <p className="font-semibold">{t}</p>
                    <p className="mt-1 text-sm text-white/65">{b}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="min-w-0">
            <CodeTabs base={BASE} />
          </div>
        </div>
      </section>

      {/* Sellers */}
      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:py-20">
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_1fr]">
          <div>
            <Eyebrow>For compute sellers</Eyebrow>
            <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-[2.1rem]">
              Turn spare compute into Fuel balance
            </h2>
            <p className="mt-3 text-[15px] text-muted sm:text-base">
              Open a tab and your laptop runs small embedding jobs for agents.
              You&apos;re paid for every result a second machine agrees with, so
              honest work always pays and made-up answers never do. Have GPUs?
              List an endpoint at your own price.
            </p>
            <Checks
              className="mt-6"
              items={[
                "No install: it runs in a browser tab",
                `${sellerShare}% of each verified job`,
                "GPU endpoints tested automatically, live in seconds",
              ]}
            />
            <div className="mt-6 flex flex-wrap gap-2 sm:mt-8 sm:gap-3">
              <Link
                href="/lane"
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white hover:bg-accent-strong"
              >
                Open the laptop lane
              </Link>
              <Link
                href="/sell"
                className="rounded-lg px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base btn-2"
              >
                List GPUs
              </Link>
            </div>
          </div>
          <div className="art-well hidden place-items-center rounded-3xl p-6 sm:grid">
            <LaptopArt className="h-auto w-full max-w-md" />
          </div>
        </div>
        <div className="mt-10 hidden rounded-3xl border border-line bg-card p-6 sm:block sm:p-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold tracking-tight">
              How every laptop result is checked
            </p>
            <p className="font-mono text-xs text-faint">
              two laptops · hidden tests · paid on match
            </p>
          </div>
          <div className="mt-6 overflow-x-auto">
            <div className="mx-auto min-w-[560px] max-w-3xl">
              <LaneVerify share={sellerShare} />
            </div>
          </div>
        </div>
      </section>

      {/* Community */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-12 sm:pb-20">
        <SectionHead
          eyebrow="Community"
          title="Agents people keep running"
          lead="Every agent can have a public page. Its community tops it up from their wallets or a shareable Blink link."
        />
        <div className="mt-5 sm:mt-8">
          <Suspense
            fallback={
              <div className="h-32 rounded-xl border border-line bg-card" />
            }
          >
            <AgentCards />
          </Suspense>
        </div>
      </section>

      {/* Privacy + final CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-14 sm:pb-24">
        <div className="grid gap-6 rounded-2xl border border-line bg-card p-5 sm:p-8 md:grid-cols-[1fr_1.2fr] md:p-10">
          <div>
            <Eyebrow>Private by default</Eyebrow>
            <h2 className="mt-2 text-2xl font-bold tracking-tight">
              Your wallet is the only identity
            </h2>
            <p className="mt-2 text-sm text-muted">
              Fuel knows who&apos;s paying and how much. It never keeps what
              your jobs were.
            </p>
          </div>
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            {[
              ["Job content", "Never logged, never stored"],
              ["Receipts", "Price, time and provider only"],
              ["Agent pages", "Balance, jobs and community top-ups"],
              ["Private top-ups", "Amount hidden on-chain"],
            ].map(([k, v]) => (
              <div key={k} className="border-t border-line pt-3">
                <dt className="text-xs text-faint">{k}</dt>
                <dd className="mt-0.5 font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="relative mt-8 overflow-hidden rounded-3xl bg-[#3a3a3a] sm:mt-10 px-5 py-10 text-center sm:px-6 sm:py-16 text-white shadow-2xl shadow-black/20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              background:
                "radial-gradient(60% 80% at 50% 0%, rgba(255,255,255,0.22), transparent 70%)",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.18]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)",
              backgroundSize: "40px 40px",
              maskImage:
                "radial-gradient(70% 70% at 50% 40%, #000, transparent)",
              WebkitMaskImage:
                "radial-gradient(70% 70% at 50% 40%, #000, transparent)",
            }}
          />
          <div className="relative">
            <h2 className="text-2xl font-bold tracking-tight sm:text-5xl">
              Give your agents their own compute.
            </h2>
            <p className="mt-3 text-sm text-white/70 sm:mt-4 sm:text-base">
              Try a prompt free, no wallet needed. Or start selling your compute.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2 sm:mt-9 sm:gap-3">
              <Link
                href="/studio"
                className="rounded-lg bg-[#e9e9e9] px-4 py-2.5 text-sm font-semibold sm:px-6 sm:py-3 sm:text-base text-ink shadow-lg shadow-black/20 hover:bg-[#d4d4d4]"
              >
                Try a prompt free
              </Link>
              <Link
                href="/dashboard"
                className="rounded-lg border border-white/25 bg-white/10 px-4 py-2.5 text-sm font-medium sm:px-6 sm:py-3 sm:text-base text-white hover:bg-white/20"
              >
                Fuel your agents
              </Link>
              <Link
                href="/sell"
                className="rounded-lg border border-white/25 bg-white/10 px-4 py-2.5 text-sm font-medium sm:px-6 sm:py-3 sm:text-base text-white hover:bg-white/20"
              >
                Sell compute
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

async function HeroDiagram() {
  await connection();
  return <RoutingDiagram cheapest={await cheapestChat()} />;
}

async function LiveStrip() {
  await connection();
  const db = supabaseAdmin();
  const [models, laptops, { count: agents }, { count: jobs }] =
    await Promise.all([
      catalogue()
        .then((c) => c.size)
        .catch(() => 0),
      onlineWorkers()
        .then((w) => w.length)
        .catch(() => 0),
      db.from("agents").select("wallet", { count: "exact", head: true }),
      db
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "succeeded"),
    ]);
  // Counts appear once they're above zero; until then, facts that are true today fill the strip.
  const cheapest = await cheapestChat();
  const items = [
    [String(models), "models live"],
    ...(jobs ? [[jobs.toLocaleString("en-US"), "jobs run"]] : []),
    ...(agents ? [[String(agents), "public agents"]] : []),
    ...(laptops ? [[String(laptops), "laptops selling"]] : []),
    ...(cheapest ? [[cheapest.price, "per 1M tokens, from"]] : []),
    [`${sellerShare}%`, "of each job to sellers"],
  ].slice(0, 4);
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 sm:flex sm:flex-wrap sm:gap-x-8 sm:pt-5">
      {items.map(([n, l]) => (
        <div key={l}>
          <dt className="text-xs text-faint">{l}</dt>
          <dd className="text-lg font-semibold tabular-nums tracking-tight sm:text-xl">
            {n}
          </dd>
        </div>
      ))}
    </dl>
  );
}

async function AgentCards() {
  await connection();
  const agents = await listAgents("fuel", 6).catch(() => []);
  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-dashed border-line-strong p-5 sm:p-8 sm:flex-row sm:items-center">
        <div>
          <p className="font-semibold">No public agents yet</p>
          <p className="mt-1 text-sm text-muted">
            Make yours the first: a page, a Blink, and a community that can fuel
            it.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong"
        >
          Make your agent public
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((a) => (
        <Link
          key={a.name}
          href={`/agent/${a.name}`}
          className="lift group rounded-xl border border-line bg-card p-5"
        >
          <p className="font-mono text-[11px] text-faint">/agent/{a.name}</p>
          <p className="mt-1 font-semibold tracking-tight group-hover:underline">
            {a.display_name}
          </p>
          {a.description && (
            <p className="mt-1 line-clamp-2 text-sm text-muted">
              {a.description}
            </p>
          )}
          <div className="mt-4 flex gap-5 text-xs text-muted">
            <span>
              <span className="font-semibold tabular-nums text-ink">
                ${a.community_fuel_usd.toFixed(2)}
              </span>{" "}
              fuelled
            </span>
            <span>
              <span className="font-semibold tabular-nums text-ink">
                {a.supporters}
              </span>{" "}
              supporters
            </span>
            <span>
              <span className="font-semibold tabular-nums text-ink">
                {a.jobs_completed}
              </span>{" "}
              jobs
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
