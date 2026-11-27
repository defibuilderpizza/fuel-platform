import { connection } from "next/server";
import { catalogue } from "@/lib/providers";
import { markupBps } from "@/lib/money";
import { LANE } from "@/lib/lane";
import { LANE_MODEL } from "@/lib/lane-crypto";

// "What compute costs right now": live prices from Fuel's catalogue (provider cost + markup),
// cheapest first. The bar shows each model's price relative to the most expensive one shown.

type Card = { id: string; kind: string; inPerM: number; outPerM: number; providers: number; context: number | null; seller?: string };

const fmt = (n: number) => (n === 0 ? "$0" : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const ctx = (n: number | null) => (!n ? null : n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M ctx` : n >= 1000 ? `${Math.round(n / 1000)}K ctx` : `${n} ctx`);

export async function cheapestChat() {
  const m = 1 + markupBps() / 10_000;
  const rows = [...(await catalogue().catch(() => new Map())).entries()].filter(([, c]) => c.kind === "chat");
  rows.sort(([, a], [, b]) => a.inPerM * 3 + a.outPerM - (b.inPerM * 3 + b.outPerM));
  const [id, c] = rows[0] ?? [];
  return id ? { model: id as string, price: fmt(c.inPerM * m) } : undefined;
}

export default async function MarketCards() {
  await connection();
  const m = 1 + markupBps() / 10_000;
  const cards: Card[] = [...(await catalogue().catch(() => new Map())).entries()]
    .filter(([, c]) => c.kind === "chat")
    .map(([id, c]) => ({ id, kind: c.kind, inPerM: c.inPerM * m, outPerM: c.outPerM * m, providers: c.providers, context: c.context }))
    .sort((a, b) => a.inPerM * 3 + a.outPerM - (b.inPerM * 3 + b.outPerM))
    .slice(0, 3);
  cards.push({ id: LANE_MODEL, kind: "embedding", inPerM: LANE.pricePerMTokUsd, outPerM: 0, providers: 0, context: 512, seller: "laptops" });
  const max = Math.max(...cards.map((c) => c.inPerM * 3 + c.outPerM), 0.0001);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => {
        const [org, ...rest] = c.id.split("/");
        const name = rest.join("/") || org;
        const share = Math.max(0.04, (c.inPerM * 3 + c.outPerM) / max);
        return (
          <div key={c.id} className="lift group flex flex-col rounded-xl border border-line bg-card p-3.5 sm:p-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{c.kind}</span>
              <span className="rounded-md bg-white/70 px-1.5 py-0.5 font-mono text-[10px] text-muted">{c.seller ?? `${c.providers} provider${c.providers === 1 ? "" : "s"}`}</span>
            </div>
            <p className="mt-2 truncate text-xs text-faint sm:mt-3">{rest.length ? org : "fuel"}</p>
            <p className="truncate font-semibold tracking-tight" title={c.id}>
              {name}
            </p>
            <div className="mt-2 flex items-baseline gap-1.5 sm:mt-4">
              <span className="text-lg font-semibold tabular-nums tracking-tight sm:text-xl">{fmt(c.inPerM)}</span>
              <span className="text-xs text-muted">in</span>
              {c.outPerM > 0 && (
                <>
                  <span className="text-faint">/</span>
                  <span className="text-sm font-medium tabular-nums">{fmt(c.outPerM)}</span>
                  <span className="text-xs text-muted">out</span>
                </>
              )}
            </div>
            <p className="text-[11px] text-faint">per 1M tokens{ctx(c.context) ? ` · ${ctx(c.context)}` : ""}</p>
            <div className="mt-3 h-1 w-full rounded-full bg-black/5">
              <div className="h-1 rounded-full bg-accent/70" style={{ width: `${share * 100}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
