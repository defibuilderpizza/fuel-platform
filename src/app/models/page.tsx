import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Eyebrow } from "@/components/ui";
import { catalogue } from "@/lib/providers";
import { markupBps } from "@/lib/money";
import { LANE, onlineWorkers } from "@/lib/lane";
import { LANE_MODEL } from "@/lib/lane-crypto";
import { describe, type ModelCard } from "@/lib/model-info";
import { mediaCatalogue } from "@/lib/media";
import ModelBadges from "@/components/model-badges";
import ModelsCatalog from "./models-catalog";

export const metadata: Metadata = {
  title: "Models",
  description: "Every model on Fuel in plain words: text, pictures, video, voice and 3D, with live prices. Try any of them in the studio.",
};

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:space-y-8 sm:py-14">
      <section className="flex flex-wrap items-end justify-between gap-4 sm:gap-6">
        <div className="max-w-2xl space-y-2 sm:space-y-3">
          <Eyebrow>Models</Eyebrow>
          <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Every model, one key</h1>
          <p className="text-[15px] text-muted sm:text-lg">
            Pick a model by what it&apos;s good at. Each job goes to the cheapest healthy provider for it, and you pay what the job actually used.
          </p>
        </div>
        <div className="flex gap-2 sm:gap-3">
          <Link href="/studio" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white shadow-sm hover:bg-accent-strong">
            Open studio
          </Link>
          <Link href="/market" className="rounded-lg px-4 py-2 text-sm font-medium btn-2 sm:px-5 sm:py-2.5 sm:text-base">
            All provider prices
          </Link>
        </div>
      </section>
      <Suspense fallback={<div className="h-96 rounded-3xl border border-line bg-card" />}>
        <Catalog />
      </Suspense>
      <Suspense fallback={null}>
        <Media />
      </Suspense>
    </main>
  );
}

async function Catalog() {
  await connection();
  const m = 1 + markupBps() / 10_000;
  const r = (n: number) => Math.round(n * m * 1e6) / 1e6;
  const cards: ModelCard[] = [...(await catalogue()).entries()].map(([id, c]) => ({
    id,
    kind: c.kind,
    ...describe(id, c.kind),
    inPerM: r(c.inPerM),
    outPerM: r(c.outPerM),
    context: c.context,
    providers: c.providers,
  }));
  if ((await onlineWorkers()).length >= 2) {
    cards.push({ id: LANE_MODEL, kind: "embedding", ...describe(LANE_MODEL, "embedding"), inPerM: LANE.pricePerMTokUsd, outPerM: 0, context: 512, providers: 2 });
  }
  return <ModelsCatalog cards={cards} />;
}

const KIND = {
  image: ["Pictures", "picture", "picture"],
  video: ["Video", "clip", "video"],
  speech: ["Voice", "1,000 characters", "voice"],
  transcription: ["Transcription", "minute of audio", "voice"],
  mesh: ["3D", "3D model", "3d"],
} as const;

async function Media() {
  await connection();
  const all = await mediaCatalogue();
  if (!all.length) return null;
  return (
    <section className="space-y-8">
      {(["image", "video", "speech", "transcription", "mesh"] as const).map((k) => {
        const list = all.filter((x) => x.kind === k);
        if (!list.length) return null;
        return (
          <div key={k} className="space-y-3">
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">{KIND[k][0]}</h2>
            <div className="grid gap-2.5 sm:gap-3 md:grid-cols-2 lg:grid-cols-3">
              {list.map((c) => (
                <div key={c.model} className="flex flex-col rounded-2xl border border-line bg-card p-4 sm:p-5">
                  <p className="truncate font-semibold tracking-tight" title={c.model}>
                    {c.model.split("/").pop()}
                  </p>
                  <p className="truncate font-mono text-xs text-faint">{c.model.split("/")[0]}</p>
                  <p className="mt-2 line-clamp-2 flex-1 text-[13px] text-muted sm:mt-3 sm:line-clamp-none sm:text-sm">{c.blurb}</p>
                  <div className="mt-2">
                    <ModelBadges quality={c.quality} speed={c.speed} recommended={c.recommended} tags={c.tags} />
                  </div>
                  {c.privacy && <p className="mt-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-snug sm:mt-3 sm:px-3 sm:py-2 sm:text-xs">Privacy: {c.privacy}</p>}
                  <div className="mt-3 flex items-end justify-between gap-3 border-t border-line pt-2.5 sm:mt-4 sm:pt-3">
                    <p className="text-xs tabular-nums">
                      <span className="text-base font-semibold">${c.priceUsd.toFixed(c.priceUsd < 0.01 ? 4 : 3)}</span> per {KIND[k][1]}
                    </p>
                    <Link href={`/studio?tab=${KIND[k][2]}&model=${encodeURIComponent(c.model)}`} className="rounded-lg px-3 py-1.5 text-sm font-medium btn-2">
                      Try
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
