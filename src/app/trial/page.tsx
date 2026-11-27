import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Checks, Eyebrow } from "@/components/ui";
import { marketRates } from "@/lib/market";
import { mediaCatalogue } from "@/lib/media";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const metadata: Metadata = {
  title: "Free trial",
  description: "Try every Fuel studio feature free: text, pictures, video, 3D and voice. No wallet, no card, no sign-up. When the credits run out, sign in or create a wallet to top up.",
};

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 sm:space-y-8 px-4 py-8 sm:space-y-12 sm:py-14">
      <section className="grid items-end gap-6 sm:gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-3 sm:space-y-4">
          <Eyebrow>Free trial</Eyebrow>
          <h1 className="text-3xl font-bold tracking-tight sm:text-6xl">Try a prompt, free</h1>
          <p className="max-w-xl text-[15px] text-muted sm:text-lg">
            Try text, pictures, video, 3D and voice with free credits. No wallet, no card, no sign-up.
            <span className="hidden sm:inline"> Every answer comes with its receipt, so you see exactly what each one used.</span>
          </p>
          <div className="flex flex-wrap gap-2 sm:gap-3">
            <Link href="/studio" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-strong sm:px-5 sm:py-2.5 sm:text-base">
              Try a prompt now
            </Link>
            <Link href="/dashboard?trial=1" className="rounded-lg px-4 py-2 text-sm font-medium btn-2 sm:px-5 sm:py-2.5 sm:text-base">
              I have a wallet
            </Link>
          </div>
        </div>
        <Checks
          className="hidden rounded-3xl border border-line bg-card p-6 sm:block"
          items={[
            "Free credits for every studio feature",
            "No wallet, card or email needed",
            "One trial per computer and per network",
            "When they run out: sign in or create a wallet to top up",
          ]}
        />
      </section>

      <Suspense fallback={<div className="h-40 rounded-3xl border border-line bg-card" />}>
        <WhatItBuys />
      </Suspense>

      <section className="grid gap-3 sm:gap-4 md:grid-cols-3">
        <Path eyebrow="Just looking" title="Try it in the studio" steps={["Open the studio and press Try free", "Run prompts, make pictures, a short video, a 3D model or a voice clip", "See a receipt for every job"]} href="/studio" cta="Try a prompt now" primary />
        <Path
          eyebrow="For one agent"
          title="Free credits on a wallet"
          steps={["Connect the agent's wallet and sign in", "Claim the free credits on the dashboard (any wallet, once)", "Point any OpenAI SDK at Fuel with the API key you get"]}
          href="/dashboard?trial=1"
          cta="Set up an agent"
        />
        <Path
          eyebrow="For a team"
          title="Try it across your agents"
          steps={["Sign in with the wallet you fund agents from", "Claim the free credits on that wallet", "Create a team, add agents and set their limits"]}
          href="/teams?trial=1"
          cta="Set up a team"
        />
      </section>

      <section className="grid gap-3 sm:gap-4 md:grid-cols-3">
        {[
          [
            "What the trial covers",
            "Without a wallet: text models up to $1 per 1M tokens (including Claude Haiku and the open models, up to 1,024 tokens an answer), FLUX schnell pictures, 2 LTX-Video clips, 2 TRELLIS 3D models, 5 Kokoro voice clips (500 characters each) and 2 Whisper transcriptions. Claim on a wallet for every model.",
          ],
          ["When the credits run out", "Sign in with a Solana or EVM wallet, or create one in a minute, and top up with USDC or SOL (Solana) or USDG (Robinhood Chain). You pay only for what you use, with a receipt for every job."],
          ["What Fuel keeps", "Price, time, provider and token counts for each job. Never your prompts or answers. For the no-wallet trial, a hashed network address and a device cookie, so each computer gets one trial."],
        ].map(([t, b]) => (
          <div key={t} className="rounded-2xl border border-line bg-card p-4 sm:p-6">
            <p className="font-semibold tracking-tight">{t}</p>
            <p className="mt-2 text-sm text-muted">{b}</p>
          </div>
        ))}
      </section>
    </main>
  );
}

function Path({ eyebrow, title, steps, href, cta, primary = false }: { eyebrow: string; title: string; steps: string[]; href: string; cta: string; primary?: boolean }) {
  return (
    <div className="flex flex-col rounded-3xl border border-line bg-card p-5 sm:p-7">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-1.5 text-xl font-bold tracking-tight sm:mt-2 sm:text-2xl">{title}</h2>
      <ol className="mt-3 flex-1 space-y-1.5 text-sm sm:mt-4 sm:space-y-2">
        {steps.map((s, i) => (
          <li key={s} className="flex gap-3">
            <span className="font-mono text-xs text-faint">{String(i + 1).padStart(2, "0")}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <Link href={href} className={`mt-4 rounded-lg px-4 py-2 text-center text-sm font-medium sm:mt-6 sm:px-5 sm:py-2.5 sm:text-base ${primary ? "bg-accent text-white shadow-sm hover:bg-accent-strong" : "btn-2"}`}>
        {cta}
      </Link>
    </div>
  );
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.floor(n)));

async function WhatItBuys() {
  await connection();
  const [rates, media, { data: cfg }] = await Promise.all([marketRates(), mediaCatalogue(), supabaseAdmin().from("faucet_config").select("trial_micro").eq("id", 1).maybeSingle()]);
  const credit = Number(cfg?.trial_micro ?? 1_000_000) / 1e6;
  // Tokens the credits buy at a typical 3:1 input:output job, at what agents pay.
  const perUsd = (p: { in: number; out: number }) => 1e6 / ((p.in * 3 + p.out) / 4);
  const pick = (re: RegExp) => rates.find((r) => r.kind === "chat" && re.test(r.model));
  const cards = [
    [pick(/^openai\/gpt-oss-120b$/), "Open model"],
    [pick(/^anthropic\/claude-haiku-5-5$/) ?? pick(/claude-haiku/), "Claude Haiku"],
    [pick(/qwen/i), "Qwen"],
  ]
    .filter(([r]) => r)
    .map(([r, label]) => {
      const rate = r as (typeof rates)[number];
      return { label: label as string, model: rate.model, value: `${fmt(perUsd(rate.agent_price) * credit)} tokens` };
    });
  const flux = media.find((x) => x.model === "black-forest-labs/FLUX.1-schnell");
  if (flux) cards.push({ label: "Quick pictures", model: flux.model, value: `${fmt(credit / flux.priceUsd)} pictures` });
  if (!cards.length) return null;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">What the free credits buy</h2>
        <p className="text-xs text-faint">Live prices · tokens at a 3:1 input:output mix · one model at a time</p>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        {cards.map((p) => (
          <div key={p.label} className="rounded-2xl border border-line bg-card p-3.5 sm:p-5">
            <p className="text-xs text-muted">{p.label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums sm:text-3xl">≈ {p.value.split(" ")[0]}</p>
            <p className="mt-1 truncate font-mono text-xs text-muted" title={p.model}>
              {p.value.split(" ")[1]} on {p.model.split("/").pop()}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
