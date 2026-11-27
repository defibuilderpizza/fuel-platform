"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { startJob, useTabJob } from "@/components/jobs";
import { fuelCall, saveKey, useFuelKey } from "@/components/fuel-key";
import Progress from "./progress";
import { useDraft } from "@/components/draft";
import ModelBadges from "@/components/model-badges";
import { bestTrialChat, chatLabels, chatTags, RECOMMENDED, trialCovers } from "@/lib/labels";
import { allowance, OutOfCredits, refreshBalance, StartTrial, TrialLeft, useAccount } from "./trial";

type M = { id: string; inPerM: number; outPerM: number };
type Receipt = { job_id: string; provider: string; price_usd: number; input_tokens: number; output_tokens: number; latency_ms: number };
type Reply = { choices?: { message?: { content?: string } }[]; fuel?: Receipt };


export default function TextTab({ models }: { models: M[] }) {
  const key = useFuelKey();
  const params = useSearchParams();
  const wanted = params.get("model");
  const prefill = params.get("prompt");
  const [model, setModel] = useState<string | null>(null);
  const [prompt, setPrompt] = useDraft("prompt");
  const [maxTokens, setMaxTokens] = useState(512);
  const [localErr, setErr] = useState<string | null>(null);
  // The run lives in the shared job store, so it keeps going if you leave the page.
  const job = useTabJob("text");
  const busy = job?.status === "running";
  const out = job?.status === "done" ? { text: String(job.result?.text ?? ""), fuel: job.fuel as Receipt | undefined } : null;
  const err = localErr ?? (job?.status === "failed" ? (job.error ?? null) : null);
  const acctEarly = useAccount(key);
  const tags = useMemo(() => chatTags(models), [models]);
  const trialPick = useMemo(() => bestTrialChat(models), [models]);
  // Every picker opens on the recommended (best-quality) model. Free-trial guests can't use it,
  // so they start on the best model the trial covers.
  // No wallet yet, or on the free trial: recommend (and default to) the best model the trial covers.
  const isGuestNow = !key || !!acctEarly?.wallet.startsWith("guest:");
  const recId = isGuestNow && trialPick ? trialPick : RECOMMENDED.chat;
  const recommended = models.find((m) => m.id === RECOMMENDED.chat)?.id ?? models[0]?.id ?? "";
  const asked = models.find((m) => m.id === wanted)?.id;
  const initial = isGuestNow && trialPick && (!asked || asked === recommended) ? trialPick : (asked ?? recommended);
  const chosen = model ?? initial;
  const fellBack = isGuestNow && !model && initial === trialPick && (asked ?? recommended) !== trialPick;
  const text = prompt ?? prefill ?? "";
  const m = models.find((x) => x.id === chosen);
  const acct = acctEarly;
  const guest = !!acct?.wallet.startsWith("guest:");
  const trialMode = isGuestNow;
  const outOfCredits = (!!err && /balance|top up|insufficient/i.test(err)) || (!!acct && acct.available_usd <= 0);

  function run() {
    setErr(null);
    const body = { model: chosen, max_tokens: maxTokens, messages: [{ role: "user", content: text }] };
    // Text: about 2 s to start plus ~80 tokens a second for the longest answer allowed.
    startJob({ kind: "text", tab: "text", model: chosen, stage: "Writing the answer…", typicalSeconds: Math.round(2 + maxTokens / 80) }, async () => {
      try {
        const r = await fuelCall<Reply>(key, "/v1/chat/completions", body);
        return { result: { text: r.choices?.[0]?.message?.content ?? "" }, fuel: r.fuel ?? null };
      } finally {
        refreshBalance();
      }
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4 rounded-3xl border border-line bg-card p-4 sm:p-6">
        <div className="flex flex-wrap gap-2.5 sm:gap-3">
          <label className="w-full min-w-0 text-sm sm:w-auto sm:flex-1">
            <span className="text-muted">Model</span>
            <select value={chosen} onChange={(e) => setModel(e.target.value)} className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 font-mono text-sm">
              {models.map((x) => (
                <option key={x.id} value={x.id} disabled={trialMode && !trialCovers("chat", x.id, x)}>
                  {`${x.id === recId ? "★ " : ""}${x.id}${tags[x.id]?.includes("cheapest") ? " · cheapest" : ""}${tags[x.id]?.includes("fastest") ? " · fastest" : ""}${trialMode ? (trialCovers("chat", x.id, x) ? " · free trial" : " · sign in to use") : ""}`}
                </option>
              ))}
            </select>
          </label>
          <label className="w-full text-sm sm:w-auto">
            <span className="text-muted">Max answer length</span>
            <select value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 text-sm">
              {[128, 512, 1024, 2048].map((n) => (
                <option key={n} value={n}>
                  {n} tokens
                </option>
              ))}
            </select>
          </label>
        </div>
        {chosen && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="font-mono text-xs">{chosen.split("/").pop()}</span>
            <ModelBadges {...chatLabels(chosen)} recommended={chosen === recId} tags={tags[chosen]} trial={trialMode ? trialCovers("chat", chosen, m) : null} />
          </p>
        )}
        {fellBack && <p className="text-xs text-muted">The free trial covers lower-cost models, so this starts on the best one it includes. Sign in to use ★ {RECOMMENDED.chat.split("/").pop()}.</p>}
        <label className="block text-sm">
          <span className="text-muted">Prompt</span>
          <textarea
            value={text}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="Summarise the pros and cons of running AI agents on a prepaid budget."
            className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2"
          />
        </label>
        <TrialLeft acct={acct} label={m && acct ? allowance(acct.available_usd, m) : null} />
        {key && outOfCredits ? (
          <OutOfCredits guest={guest} apiKey={key} onError={setErr} onClaimed={() => setErr(null)} />
        ) : key ? (
          <button onClick={run} disabled={busy || !text.trim() || !chosen} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium sm:px-5 sm:py-2.5 sm:text-base text-white shadow-sm hover:bg-accent-strong disabled:opacity-50">
            {busy ? "Running…" : "Run"}
          </button>
        ) : (
          <StartTrial onError={setErr} />
        )}
        <Progress startedAt={job && job.status !== "failed" ? job.startedAt : null} typicalSeconds={job?.typicalSeconds ?? 8} done={job?.status === "done"} label={job?.stage ?? null} />
        {err && !outOfCredits && <p className="text-sm text-bad">{err}</p>}
        {out && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-faint">Answer</p>
            <div className="whitespace-pre-wrap rounded-xl border border-line bg-white/50 p-4 text-sm leading-relaxed">{out.text || "(empty answer)"}</div>
          </div>
        )}
      </div>

      <aside className="space-y-4">
        <div className="rounded-3xl border border-line bg-card p-4 text-sm sm:p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-faint">Price</p>
          {m && (
            <p className="mt-1 tabular-nums">
              ${m.inPerM.toFixed(3)} in · ${m.outPerM.toFixed(3)} out <span className="text-faint">per 1M tokens</span>
            </p>
          )}
          {guest ? (
            <p className="mt-2 rounded-lg border border-emerald-600/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-800">Free trial: this comes out of your free credits. You won&apos;t be charged.</p>
          ) : (
            <p className="mt-2 text-xs text-muted">At most about ${m ? ((m.outPerM * maxTokens + m.inPerM * Math.max(50, text.length / 4)) / 1e6).toFixed(5) : "0"} for this run. You pay what it uses.</p>
          )}
        </div>
        {out?.fuel && (
          <div className="rounded-3xl border border-line bg-card p-4 text-sm sm:p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-faint">Receipt</p>
            <dl className="mt-2 space-y-1">
              {[
                ["Provider", out.fuel.provider],
                ["Price", guest ? `$${out.fuel.price_usd.toFixed(6)} · free credits` : `$${out.fuel.price_usd.toFixed(6)}`],
                ["Tokens", `${out.fuel.input_tokens} in · ${out.fuel.output_tokens} out`],
                ["Time", `${out.fuel.latency_ms} ms`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="truncate font-mono text-xs">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {key && (
          <button onClick={() => saveKey(null)} className="text-xs text-muted underline">
            Sign out of the studio
          </button>
        )}
        <p className="text-xs text-faint">Prompts and answers aren&apos;t stored. Only the receipt is kept.</p>
      </aside>
    </div>
  );
}
