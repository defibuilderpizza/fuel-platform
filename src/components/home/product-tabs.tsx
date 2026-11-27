"use client";

import { useState } from "react";

// Product tour, Modal-style: a tab list on the left, a small UI panel on the right.
// The panels are drawn with plain markup so they stay crisp and on-palette.

const TABS = [
  {
    id: "api",
    label: "Compute API",
    title: "One endpoint, the cheapest compute behind it",
    body: "OpenAI-compatible chat, embeddings and zero-shot classification, plus the Anthropic Messages format. Fuel checks price and uptime, routes each job to the cheapest provider, and moves it if that provider fails.",
    points: ["Streaming", "Automatic failover", "A receipt on every job"],
  },
  {
    id: "wallet",
    label: "Wallet balances",
    title: "Each agent pays from its own wallet",
    body: "Top up once with USDC or SOL on Solana, or USDG on Robinhood Chain, and jobs draw the balance down, or pay each request with x402 and skip the top-up. Teams set daily and per-job limits per agent and see every receipt in one place.",
    points: ["USDC, SOL, USDG", "Spending limits", "Free trial credits, pay later"],
  },
  {
    id: "private",
    label: "Private top-ups",
    title: "Keep what you spend off the public record",
    body: "Top up through Solana Privacy Rings. Anyone can see that a wallet paid Fuel, nobody but you and Fuel can see how much.",
    points: ["Amount hidden on-chain", "Same balance", "Up to $50 per top-up (beta)"],
  },
  {
    id: "lane",
    label: "Laptop lane",
    title: "Compute sold by laptops, checked twice",
    body: "Sellers run small embedding jobs in a browser tab. Every result is cross-checked by a second laptop before anyone gets paid.",
    points: ["No install", "70% of the job to sellers", "Canary checks"],
  },
  {
    id: "credits",
    label: "Compute credits",
    title: "Prepay tokens by tier, trade what you don't use",
    body: "Four tiers, from top closed models to embeddings. One credit is at least 1M tokens on any model of its tier, and jobs use your credits automatically. Opens after the Fuel token launch.",
    points: ["Max, Pro, Open, Lane", "Trade or convert down a tier", "Auto top-up and sell rules"],
  },
] as const;

export default function ProductTabs() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("api");
  const t = TABS.find((x) => x.id === tab)!;
  return (
    <div className="grid gap-5 sm:gap-6 lg:grid-cols-[220px_1fr_1.1fr]">
      <div role="tablist" aria-label="Fuel products" className="flex gap-1 overflow-x-auto lg:flex-col">
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={`shrink-0 rounded-lg px-3 py-2 text-left text-sm transition ${tab === x.id ? "bg-white/80 font-medium text-ink shadow-sm" : "text-muted hover:text-ink"}`}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="space-y-3">
        <h3 className="text-lg font-semibold tracking-tight sm:text-xl">{t.title}</h3>
        <p className="text-[15px] text-muted sm:text-base">{t.body}</p>
        <ul className="space-y-1.5 pt-1 text-sm">
          {t.points.map((p) => (
            <li key={p} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-xl border border-line bg-card p-4 shadow-xl shadow-black/5 sm:p-5">
        {tab === "api" && <ApiPanel />}
        {tab === "wallet" && <WalletPanel />}
        {tab === "private" && <PrivatePanel />}
        {tab === "lane" && <LanePanel />}
        {tab === "credits" && <CreditsPanel />}
      </div>
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{children}</p>;

function ApiPanel() {
  const rows = [
    ["together", "$0.16 / 1M", "chosen", "w-[38%]"],
    ["gpu seller", "$0.19 / 1M", "backup", "w-[46%]"],
    ["other", "$0.42 / 1M", "", "w-[90%]"],
  ];
  return (
    <div className="space-y-4">
      <Label>Example · routing openai/gpt-oss-120b</Label>
      <div className="space-y-2.5">
        {rows.map(([name, price, state, w]) => (
          <div key={name} className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className={state === "chosen" ? "font-medium" : "text-muted"}>
                {name} {state === "chosen" && <span className="ml-1 text-xs text-ok">● chosen</span>}
                {state === "backup" && <span className="ml-1 text-xs text-faint">failover</span>}
              </span>
              <span className="font-mono text-xs tabular-nums">{price}</span>
            </div>
            <div className="h-1.5 rounded-full bg-black/5">
              <div className={`h-1.5 rounded-full ${state === "chosen" ? "bg-accent" : "bg-[#9b9b9b]"} ${w}`} />
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-line bg-white/70 p-3 font-mono text-[11px] leading-relaxed text-muted">
        {"{ provider: \"together\", price_usd: 0.000044,"}
        <br />
        {"  latency_ms: 897, attempts: 1 }"}
      </div>
    </div>
  );
}

function WalletPanel() {
  return (
    <div className="space-y-4">
      <Label>Example · agent research-bot</Label>
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs text-muted">Available</p>
          <p className="text-3xl font-semibold tabular-nums tracking-tight">$12.40</p>
        </div>
        <span className="rounded-md bg-white/80 px-2 py-1 text-xs text-muted">limit $5 / day</span>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line bg-white/60 text-sm">
        {[
          ["USDC top-up", "+$10.00", "text-ok"],
          ["gpt-oss-120b · 1.2k tokens", "−$0.0004", ""],
          ["SOL top-up", "+$4.87", "text-ok"],
          ["bge-small · laptop lane", "−$0.00002", ""],
        ].map(([k, v, c]) => (
          <li key={k} className="flex justify-between px-3 py-2">
            <span className="text-muted">{k}</span>
            <span className={`font-mono text-xs tabular-nums ${c}`}>{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PrivatePanel() {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-5">
      <svg viewBox="0 0 120 120" className="h-28 w-28" aria-hidden>
        {Array.from({ length: 18 }).map((_, i) => {
          const a = (i / 18) * Math.PI * 2;
          return <circle key={i} cx={60 + Math.cos(a) * 44} cy={60 + Math.sin(a) * 44} r={i % 3 === 0 ? 4 : 2.5} fill={i % 3 === 0 ? "#474747" : "#9b9b9b"} />;
        })}
        <circle cx="60" cy="60" r="22" fill="#474747" />
        <path d="M54 58 v-5 a6 6 0 0 1 12 0 v5" stroke="#fff" strokeWidth="2" fill="none" />
        <rect x="50" y="58" width="20" height="14" rx="3" fill="#fff" />
      </svg>
      <div className="space-y-2 text-sm">
        <Label>On-chain, anyone sees</Label>
        <p>
          Wallet <span className="font-mono text-xs">7xK…q9</span> paid Fuel <span className="text-ok">✓</span>
        </p>
        <Label>Hidden</Label>
        <p className="font-mono text-xs text-muted">asset ••••  ·  amount ••••••</p>
        <Label>Your balance</Label>
        <p className="font-semibold">+$25.00 credited</p>
      </div>
    </div>
  );
}

function Laptop({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="w-24 rounded-t-md border border-line bg-white/80 p-1.5">
        <div className="space-y-1 rounded-sm bg-[#e9e9e9] p-1.5 font-mono text-[8px] text-muted">
          <p>[0.0213, −0.114,</p>
          <p> 0.0871, 0.0042…]</p>
        </div>
      </div>
      <div className="h-1.5 w-28 rounded-b-md bg-[#9b9b9b]" />
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function LanePanel() {
  return (
    <div className="space-y-4">
      <Label>Example · one task, two laptops</Label>
      <div className="flex items-center justify-around">
        <Laptop label="laptop A" />
        <div className="flex flex-col items-center text-xs">
          <span className="rounded-full bg-ok/10 px-2 py-0.5 font-medium text-ok">match 0.9998</span>
          <span className="mt-1 text-faint">⟷</span>
        </div>
        <Laptop label="laptop B" />
      </div>
      <p className="text-center text-sm">
        Both paid <span className="font-semibold">35%</span> each, in Fuel balance
      </p>
    </div>
  );
}

function CreditsPanel() {
  const tiers = [
    ["Max", "Claude Opus, GPT Astra"],
    ["Pro", "Claude Sonnet, GPT, Kimi K3"],
    ["Open", "Qwen, DeepSeek, MiniMax"],
    ["Lane", "Embeddings, classification"],
  ];
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <Label>1 credit = 1M+ tokens on its tier</Label>
        <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-medium text-muted">After token launch</span>
      </div>
      <ul className="divide-y divide-line">
        {tiers.map(([t, m]) => (
          <li key={t} className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="font-semibold">{t}</span>
            <span className="truncate text-xs text-muted">{m}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Live prices and tokens per model on the credits page.</p>
    </div>
  );
}
