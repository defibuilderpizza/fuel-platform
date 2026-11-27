"use client";

import { useState } from "react";
import { fuelCall, useFuelKey } from "@/components/fuel-key";
import { startJob, useTabJob } from "@/components/jobs";
import ModelBadges from "@/components/model-badges";
import { TRIAL_MEDIA } from "@/lib/labels";
import Progress from "./progress";
import { useDraft } from "@/components/draft";
import { OutOfCredits, refreshBalance, StartTrial, useAccount } from "./trial";
import type { MediaModel } from "./media-tab";

type Receipt = { job_id: string; provider: string; price_usd: number; latency_ms: number | null; characters?: number; audio_seconds?: number };

export default function VoiceTab({ speech, transcription }: { speech: MediaModel[]; transcription: MediaModel[] }) {
  const key = useFuelKey();
  const acct = useAccount(key);
  const [mode, setMode] = useState<"speak" | "transcribe">("speak");
  const [model, setModel] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [draft, setText] = useDraft("prompt");
  const text = draft ?? "";
  const [file, setFile] = useState<File | null>(null);
  const [localErr, setErr] = useState<string | null>(null);
  // Runs live in the shared job store, so they keep going if you leave the page.
  const job = useTabJob("voice");
  const busy = job?.status === "running";
  const done = job?.status === "done";
  const audio = done && job?.kind === "speech" ? String(job.result?.url ?? "") || null : null;
  const transcript = done && job?.kind === "transcription" ? String(job.result?.text ?? "") : null;
  const fuel = done ? (job?.fuel as Receipt | null) : null;
  const err = localErr ?? (job?.status === "failed" ? (job.error ?? null) : null);

  const list = mode === "speak" ? speech : transcription;
  // No wallet yet, or on the free trial: start on (and star) the trial's model for this mode.
  const trialMode = !key || !!acct?.wallet.startsWith("guest:");
  const trialModel = TRIAL_MEDIA[mode === "speak" ? "speech" : "transcription"];
  const m = list.find((x) => x.model === model) ?? (trialMode ? list.find((x) => x.model === trialModel.model) : undefined) ?? list[0];
  const starOf = (x: MediaModel) => (trialMode ? x.model === trialModel.model : !!x.recommended);
  const chosenVoice = voice && m?.voices.includes(voice) ? voice : (m?.voices[0] ?? "");
  const guest = !!acct?.wallet.startsWith("guest:");
  const outOfCredits = (!!err && /balance|top up|insufficient/i.test(err)) || (!!acct && acct.available_usd <= 0);
  const estimate = m ? (mode === "speak" ? (m.priceUsd * Math.max(text.length, 1)) / 1000 : m.priceUsd) : 0;

  function go() {
    setErr(null);
    const chosenModel = m!.model;
    const meta = { tab: "voice", model: chosenModel, typicalSeconds: m?.typicalSeconds ?? 10 };
    if (mode === "speak") {
      const body = { model: chosenModel, input: text, voice: chosenVoice, response_format: "url" };
      startJob({ ...meta, kind: "speech", stage: "Recording the voice…" }, async () => {
        try {
          const r = await fuelCall<{ url: string; fuel: Receipt }>(key, "/v1/audio/speech", body);
          return { result: { url: r.url }, fuel: r.fuel };
        } finally {
          refreshBalance();
        }
      });
    } else {
      const fd = new FormData();
      fd.append("model", chosenModel);
      fd.append("file", file!);
      startJob({ ...meta, kind: "transcription", stage: "Listening…" }, async () => {
        try {
          const res = await fetch("/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: fd });
          const j = (await res.json().catch(() => ({}))) as { text?: string; fuel?: Receipt; error?: { message?: string } };
          if (!res.ok) throw new Error(j.error?.message ?? `Request failed (${res.status})`);
          return { result: { text: j.text ?? "" }, fuel: j.fuel ?? null };
        } finally {
          refreshBalance();
        }
      });
    }
  }


  if (!speech.length && !transcription.length) return null;
  const ready = mode === "speak" ? !!text.trim() : !!file;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4 rounded-3xl border border-line bg-card p-4 sm:p-6">
        <div role="tablist" aria-label="Voice" className="inline-flex gap-1 rounded-lg border border-line p-1 text-sm">
          {(
            [
              ["speak", "Text to speech"],
              ["transcribe", "Speech to text"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mode === id}
              onClick={() => {
                setMode(id);
                setModel(null);
                setErr(null);
              }}
              className={`rounded-md px-3 py-1.5 ${mode === id ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2.5 sm:gap-3">
          <label className="w-full min-w-0 text-sm sm:w-auto sm:flex-1">
            <span className="text-muted">Model</span>
            <select value={m?.model ?? ""} onChange={(e) => setModel(e.target.value)} className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 font-mono text-sm">
              {list.map((x) => (
                <option key={x.model} value={x.model} disabled={trialMode && x.model !== trialModel.model}>
                  {starOf(x) ? "★ " : ""}{x.model}{x.tags?.includes("cheapest") ? " · cheapest" : ""}{x.tags?.includes("fastest") ? " · fastest" : ""}{trialMode ? (x.model === trialModel.model ? " · free trial" : " · sign in to use") : ""} · ${x.priceUsd.toFixed(3)}/{x.unit === "minute" ? "min" : "1K chars"}
                </option>
              ))}
            </select>
          </label>
          {mode === "speak" && m && m.voices.length > 0 && (
            <label className="w-full text-sm sm:w-auto">
              <span className="text-muted">Voice</span>
              <select value={chosenVoice} onChange={(e) => setVoice(e.target.value)} className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 text-sm">
                {m.voices.map((v) => (
                  <option key={v} value={v}>
                    {v.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {m && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>{m.blurb}</span>
            <ModelBadges quality={m.quality} speed={m.speed} recommended={starOf(m)} tags={m.tags} trial={trialMode ? m.model === trialModel.model : null} />
          </p>
        )}
        {m?.privacy && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <strong>Privacy:</strong> {m.privacy}
          </p>
        )}

        {mode === "speak" ? (
          <label className="block text-sm">
            <span className="text-muted">Text to read out ({text.length.toLocaleString("en-US")} / {trialMode ? "500" : "5,000"} characters)</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={trialMode ? 500 : 5000} placeholder="Welcome to Fuel, the compute market for AI agents." className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2" />
          </label>
        ) : (
          <label className="block text-sm">
            <span className="text-muted">Audio file (up to 4 MB: mp3, wav, m4a, webm)</span>
            <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-black/10 file:px-3 file:py-2" />
          </label>
        )}

        {trialMode && trialModel.limit && <p className="text-xs text-muted">Free trial includes {trialModel.limit}.</p>}
        {key && outOfCredits ? (
          <OutOfCredits guest={guest} apiKey={key} onError={setErr} onClaimed={() => setErr(null)} />
        ) : key ? (
          <button onClick={go} disabled={busy || !ready || !m} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white shadow-sm hover:bg-accent-strong disabled:opacity-50">
            {busy ? "Working…" : mode === "speak" ? "Make speech" : "Transcribe"}
          </button>
        ) : (
          <StartTrial onError={setErr} />
        )}
        <Progress startedAt={job && job.status !== "failed" ? job.startedAt : null} typicalSeconds={job?.typicalSeconds ?? 10} done={done} label={job?.stage ?? null} />
        {err && !outOfCredits && <p className="text-sm text-bad">{err}</p>}
        {audio && (
          <div className="space-y-2">
            <audio src={audio} controls autoPlay className="w-full" />
            <p className="text-xs text-muted">
              The link expires within an hour and Fuel doesn&apos;t keep a copy.{" "}
              <a href={audio} target="_blank" rel="noreferrer" className="underline">
                Save audio
              </a>
            </p>
          </div>
        )}
        {transcript !== null && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-faint">Transcript</p>
            <div className="whitespace-pre-wrap rounded-xl border border-line bg-white/50 p-4 text-sm leading-relaxed">{transcript || "(no speech found)"}</div>
          </div>
        )}
      </div>

      <aside className="space-y-4">
        <div className="rounded-3xl border border-line bg-card p-4 text-sm sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-faint">Price</p>
          {m && (
            <p className="mt-1 tabular-nums">
              <span className="text-lg font-semibold">${m.priceUsd.toFixed(3)}</span> <span className="text-faint">per {m.unit === "minute" ? "minute of audio" : "1,000 characters"}</span>
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            {mode === "speak" ? `About $${estimate.toFixed(4)} for this text.` : "Held for up to 10 minutes of audio; charged for the real length."} Charged only if it works.
          </p>
        </div>
        {fuel && (
          <div className="rounded-3xl border border-line bg-card p-4 text-sm sm:p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-faint">Receipt</p>
            <dl className="mt-2 space-y-1">
              {[
                ["Provider", fuel.provider],
                ["Price", `$${fuel.price_usd.toFixed(6)}`],
                [fuel.characters !== undefined ? "Characters" : "Audio", fuel.characters !== undefined ? String(fuel.characters) : `${fuel.audio_seconds ?? 0} s`],
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
        <p className="text-xs text-faint">Fuel doesn&apos;t store your text, audio or results, only the receipt.</p>
      </aside>
    </div>
  );
}
