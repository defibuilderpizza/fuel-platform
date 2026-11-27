"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { startJob, startPolledJob, useTabJob, type JobKind } from "@/components/jobs";
import { fuelCall, useFuelKey } from "@/components/fuel-key";
import Progress from "./progress";
import { useDraft } from "@/components/draft";
import ModelBadges from "@/components/model-badges";
import type { Quality, Speed, Tag } from "@/lib/labels";
import { TRIAL_MEDIA, trialCovers } from "@/lib/labels";
import { allowance, OutOfCredits, refreshBalance, StartTrial, TrialLeft, useAccount } from "./trial";

export type MediaModel = { model: string; priceUsd: number; unit: string; blurb: string; privacy: string | null; typicalSeconds: number | null; voices: string[]; quality: Quality | null; speed: Speed | null; recommended?: boolean; tags?: Tag[] };
type Receipt = { job_id: string; provider: string; price_usd: number; outputs: number; latency_ms: number | null };

const SIZES = [
  ["1024x1024", "Square"],
  ["768x1344", "Portrait"],
  ["1344x768", "Landscape"],
] as const;

export function ComingSoon({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-line-strong bg-card p-5 sm:p-10 text-center">
      <span className="rounded-full border border-line px-3 py-1 text-xs font-medium text-muted">Coming soon</span>
      <h2 className="mt-4 text-2xl font-bold tracking-tight">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-muted">{body}</p>
    </div>
  );
}

export default function MediaTab({ kind, models }: { kind: "image" | "video" | "mesh"; models: MediaModel[] }) {
  const key = useFuelKey();
  const wanted = useSearchParams().get("model");
  const initial = models.find((m) => m.model === wanted)?.model ?? models[0]?.model ?? "";
  const [model, setModel] = useState<string | null>(null);
  const [draft, setPrompt] = useDraft("prompt");
  const prompt = draft ?? "";
  const [size, setSize] = useState("1024x1024");
  const [localErr, setErr] = useState<string | null>(null);
  // Runs live in the shared job store, so they keep going if you leave the page.
  const tab = kind === "image" ? "picture" : kind === "video" ? "video" : "3d";
  const job = useTabJob(tab);
  const busy = job?.status === "running";
  const urls = job?.status === "done" ? ((job.result?.urls as string[] | undefined) ?? (job.result?.url ? [String(job.result.url)] : [])) : [];
  const fuel = job?.status === "done" ? (job.fuel as Receipt | null) : null;
  const preview = (job?.result?.preview_url as string | undefined) ?? null;
  const err = localErr ?? (job?.status === "failed" ? (job.error ?? null) : null);
  const acct = useAccount(key);
  const guest = !!acct?.wallet.startsWith("guest:");
  // No wallet yet, or on the free trial: pictures recommend (and default to) the trial's model.
  const trialMode = !key || guest;
  const starOf = (x: MediaModel) => (trialMode ? x.model === TRIAL_MEDIA[kind]?.model : !!x.recommended);
  // On the free trial, each feature starts on (and only allows) the trial model for it.
  const chosen = model ?? (trialMode ? (models.find((x) => x.model === TRIAL_MEDIA[kind]?.model)?.model ?? initial) : initial);
  const m = models.find((x) => x.model === chosen);
  const outOfCredits = (!!err && /balance|top up|insufficient/i.test(err)) || (!!acct && acct.available_usd <= 0);
  const noun = kind === "image" ? "picture" : kind === "video" ? "clip" : "3D model";
  // The 3D viewer is a web component; load it only on this tab.
  useEffect(() => {
    if (kind === "mesh") void import("@google/model-viewer");
  }, [kind]);

  if (!models.length) {
    const title = kind === "image" ? "Pictures" : kind === "video" ? "Video" : "3D";
    return <ComingSoon title={title} body={`${title} models are being switched on. Text works today.`} />;
  }

  function go() {
    setErr(null);
    const meta = { kind: tab as JobKind, tab, model: chosen, stage: `Making your ${noun}…`, typicalSeconds: m?.typicalSeconds ?? (kind === "image" ? 8 : kind === "video" ? 180 : 120) };
    if (kind === "image") {
      startJob(meta, async () => {
        try {
          const r = await fuelCall<{ data: { url: string }[]; fuel: Receipt }>(key, "/v1/images/generations", { model: chosen, prompt, size });
          return { result: { urls: r.data.map((d) => d.url), prompt }, fuel: r.fuel };
        } finally {
          refreshBalance();
        }
      });
    } else {
      const path = kind === "video" ? "/v1/videos" : "/v1/3d";
      startPolledJob({ ...meta, stage: `Starting your ${noun}…` }, async () => {
        const started = await fuelCall<{ id: string; preview_url?: string }>(key, path, { model: chosen, prompt });
        refreshBalance();
        return { poll: `${path}/${started.id}`, result: { prompt, ...(started.preview_url ? { preview_url: started.preview_url } : {}) } };
      });
    }
  }


  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4 rounded-3xl border border-line bg-card p-4 sm:p-6">
        <div className="flex flex-wrap gap-2.5 sm:gap-3">
          <label className="w-full min-w-0 text-sm sm:w-auto sm:flex-1">
            <span className="text-muted">Model</span>
            <select value={chosen} onChange={(e) => setModel(e.target.value)} className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 font-mono text-sm">
              {models.map((x) => (
                <option key={x.model} value={x.model} disabled={trialMode && !trialCovers(kind, x.model)}>
                  {starOf(x) ? "★ " : ""}{x.model}{x.tags?.includes("cheapest") ? " · cheapest" : ""}{x.tags?.includes("fastest") ? " · fastest" : ""}{trialMode ? (trialCovers(kind, x.model) ? " · free trial" : " · sign in to use") : ""} · ${x.priceUsd.toFixed(x.priceUsd < 0.01 ? 4 : 3)}/{x.unit}
                </option>
              ))}
            </select>
          </label>
          {kind === "image" && (
            <label className="w-full text-sm sm:w-auto">
              <span className="text-muted">Shape</span>
              <select value={size} onChange={(e) => setSize(e.target.value)} className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 text-sm">
                {SIZES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {m && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>{m.blurb}</span>
            <ModelBadges quality={m.quality} speed={m.speed} recommended={starOf(m)} tags={m.tags} trial={trialMode ? trialCovers(kind, m.model) : null} />
          </p>
        )}
        {m?.privacy && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <strong>Privacy:</strong> {m.privacy}
          </p>
        )}
        <label className="block text-sm">
          <span className="text-muted">Describe the {noun}</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder={kind === "image" ? "A glass cube on a pale desk, soft violet light, studio photograph" : kind === "video" ? "A paper boat drifting on a calm lake at sunrise" : "A small wooden treasure chest"}
            className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2"
          />
        </label>
        <TrialLeft acct={acct} label={m && acct ? allowance(acct.available_usd, { perOutput: m.priceUsd, unit: noun }) : null} />
        {trialMode && TRIAL_MEDIA[kind]?.limit && <p className="text-xs text-muted">Free trial includes {TRIAL_MEDIA[kind].limit}.</p>}
        {key && outOfCredits ? (
          <OutOfCredits guest={guest} apiKey={key} onError={setErr} onClaimed={() => setErr(null)} />
        ) : key ? (
          <button onClick={go} disabled={busy || !prompt.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white shadow-sm hover:bg-accent-strong disabled:opacity-50">
            {busy ? "Working…" : `Make ${noun}`}
          </button>
        ) : (
          <StartTrial onError={setErr} />
        )}
        <Progress startedAt={job && job.status !== "failed" ? job.startedAt : null} typicalSeconds={job?.typicalSeconds ?? 8} done={job?.status === "done"} label={job?.stage ?? null} />
        {kind === "mesh" && preview && urls.length === 0 && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="The picture your 3D model is made from" className="w-48 rounded-xl border border-line" />
        )}
        {err && !outOfCredits && <p className="text-sm text-bad">{err}</p>}
        {urls.length > 0 && (
          <div className="space-y-2">
            <div className="grid gap-3 sm:grid-cols-2">
              {urls.map((u) =>
                kind === "image" ? (
                  // Provider links are temporary and on other hosts, so a plain img is right here.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={u} src={u} alt={prompt} className="w-full rounded-xl border border-line" />
                ) : kind === "video" ? (
                  <video key={u} src={u} controls autoPlay loop muted playsInline className="w-full rounded-xl border border-line sm:col-span-2" />
                ) : (
                  <model-viewer key={u} src={u} poster={preview ?? undefined} camera-controls auto-rotate shadow-intensity="1" alt={prompt} style={{ width: "100%", height: 360 }} class="rounded-xl border border-line sm:col-span-2" />
                ),
              )}
            </div>
            <p className="text-xs text-muted">
              Links are temporary (most expire within an hour): save what you want. Fuel doesn&apos;t keep a copy.{" "}
              {urls.map((u, i) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="underline">
                  Save {noun}
                  {urls.length > 1 ? ` ${i + 1}` : ""}
                </a>
              ))}
            </p>
          </div>
        )}
      </div>

      <aside className="space-y-4">
        <div className="rounded-3xl border border-line bg-card p-4 text-sm sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-faint">Price</p>
          {m && (
            <p className="mt-1 tabular-nums">
              <span className="text-lg font-semibold">${m.priceUsd.toFixed(m.priceUsd < 0.01 ? 4 : 3)}</span> <span className="text-faint">per {m.unit}</span>
            </p>
          )}
          {guest ? (
            <p className="mt-2 rounded-lg border border-emerald-600/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-800">Free trial: this comes out of your free credits. You won&apos;t be charged.</p>
          ) : (
            <p className="mt-2 text-xs text-muted">{kind === "image" ? "Charged only if the picture is made." : `Held when you start; charged only when the ${noun} is ready.`}</p>
          )}
        </div>
        {fuel && (
          <div className="rounded-3xl border border-line bg-card p-4 text-sm sm:p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-faint">Receipt</p>
            <dl className="mt-2 space-y-1">
              {[
                ["Provider", fuel.provider],
                ["Price", guest ? `$${fuel.price_usd.toFixed(6)} · free credits` : `$${fuel.price_usd.toFixed(6)}`],
                ["Outputs", `${fuel.outputs} ${noun}${fuel.outputs === 1 ? "" : "s"}`],
                ["Time", fuel.latency_ms == null ? "–" : `${(fuel.latency_ms / 1000).toFixed(1)} s`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="truncate font-mono text-xs">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <p className="text-xs text-faint">Fuel doesn&apos;t store prompts or outputs, only the receipt.{m?.privacy ? " This model's maker may keep them (see the note)." : ""}</p>
      </aside>
    </div>
  );
}
