"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ModelCard } from "@/lib/model-info";
import ModelBadges from "@/components/model-badges";
import { chatLabels, chatTags, isRecommended } from "@/lib/labels";

const FILTERS = [
  ["all", "All"],
  ["chat", "Chat"],
  ["closed", "Claude"],
  ["open-weight", "Open-weight"],
  ["embeddings", "Embeddings"],
] as const;

const typical = (c: ModelCard) => (c.kind === "embedding" ? c.inPerM : (c.inPerM * 3 + c.outPerM) / 4);
const usd = (n: number) => (n === 0 ? "$0" : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const ctx = (n: number | null) => (!n ? null : n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1e3)}K`);

export default function ModelsCatalog({ cards }: { cards: ModelCard[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"price" | "name">("price");
  // Phones show the first few; desktop always shows the full grid.
  const [all, setAll] = useState(false);
  const tags = useMemo(() => chatTags(cards.filter((c) => c.kind === "chat")), [cards]);
  const PHONE = 12;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cards
      .filter((c) => filter === "all" || c.tags.includes(filter))
      .filter((c) => !needle || c.id.toLowerCase().includes(needle) || c.blurb.toLowerCase().includes(needle))
      .sort((a, b) => Number(isRecommended("chat", b.id)) - Number(isRecommended("chat", a.id)) || (sort === "price" ? typical(a) - typical(b) : a.id.localeCompare(b.id)));
  }, [cards, filter, q, sort]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Filter models" className="flex flex-wrap gap-1 rounded-xl border border-line bg-card p-1">
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              className={`rounded-lg px-3 py-1.5 text-sm ${filter === id ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search models"
          aria-label="Search models"
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2 text-sm sm:max-w-xs"
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as "price" | "name")} aria-label="Sort" className="rounded-lg border border-line-strong bg-transparent px-3 py-2 text-sm">
          <option value="price">Cheapest first</option>
          <option value="name">A–Z</option>
        </select>
        <p className="text-xs text-faint">{shown.length} models</p>
      </div>

      <div className="grid gap-2.5 sm:gap-3 md:grid-cols-2 lg:grid-cols-3">
        {shown.map((c, i) => (
          <div key={c.id} className={`flex-col rounded-2xl border border-line bg-card p-4 sm:flex sm:p-5 ${i >= PHONE && !all && !q ? "hidden" : "flex"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold tracking-tight" title={c.id}>
                  {c.name}
                </p>
                <p className="truncate font-mono text-xs text-faint">{c.maker}</p>
              </div>
              <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">{c.kind === "embedding" ? "embeddings" : "chat"}</span>
            </div>
            <p className="mt-2 line-clamp-2 flex-1 text-[13px] text-muted sm:mt-3 sm:line-clamp-none sm:text-sm">{c.blurb}</p>
            {c.kind === "chat" && (
              <div className="mt-2">
                <ModelBadges {...chatLabels(c.id)} recommended={isRecommended("chat", c.id)} tags={tags[c.id]} />
              </div>
            )}
            <div className="mt-3 flex items-end justify-between gap-3 border-t border-line pt-2.5 sm:mt-4 sm:pt-3">
              <div className="text-xs">
                <p className="tabular-nums">
                  <span className="text-base font-semibold">{usd(c.inPerM)}</span> in
                  {c.kind === "chat" && (
                    <>
                      {" · "}
                      <span className="text-base font-semibold">{usd(c.outPerM)}</span> out
                    </>
                  )}
                </p>
                <p className="text-faint">
                  per 1M tokens{ctx(c.context) ? ` · ${ctx(c.context)} context` : ""}
                </p>
              </div>
              {c.kind === "chat" ? (
                <Link href={`/studio?tab=text&model=${encodeURIComponent(c.id)}`} className="rounded-lg px-3 py-1.5 text-sm font-medium btn-2">
                  Try
                </Link>
              ) : (
                <Link href="/docs#compute" className="rounded-lg px-3 py-1.5 text-sm font-medium btn-2">
                  Docs
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
      {shown.length > PHONE && !all && !q && (
        <button onClick={() => setAll(true)} className="w-full rounded-lg px-4 py-2 text-sm font-medium btn-2 sm:hidden">
          Show all {shown.length} models
        </button>
      )}
      {shown.length === 0 && <p className="text-sm text-muted">No models match.</p>}
    </div>
  );
}
