"use client";

import { useEffect, useState } from "react";
import { connectWallet, fuelCall, saveKey, useFuelKey } from "@/components/fuel-key";

type ModelRow = { model: string; kind: "chat" | "embedding"; provider_model_id: string; input_per_mtok: string; output_per_mtok: string };
type Seller = {
  id: string;
  name: string;
  endpoint_url: string;
  contact: string | null;
  status: "pending" | "approved" | "rejected" | "paused";
  review_note: string | null;
  has_api_key: boolean;
  jobs_served: number;
  models: { model: string; kind: string; provider_model_id: string; input_per_mtok: number; output_per_mtok: number; probe_ok: boolean | null; probe_ms: number | null; probe_error: string | null }[];
};
type View = { sellers: Seller[]; earned_usd: number };
type Rate = { model: string; kind: string; providers: number; low: { in: number; out: number }; agent_price: { in: number; out: number }; to_win: { in: number; out: number } };
const money = (n: number) => (n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

const blank: ModelRow = { model: "", kind: "chat", provider_model_id: "", input_per_mtok: "", output_per_mtok: "" };
const input = "w-full rounded-lg border border-line-strong bg-white/70 px-3 py-2 text-sm";
const STATUS: Record<Seller["status"], string> = {
  pending: "bg-[#d4d4d4] text-ink",
  approved: "bg-ok/10 text-ok",
  rejected: "bg-bad/10 text-bad",
  paused: "bg-[#d4d4d4] text-muted",
};

export default function SellerApplication() {
  const key = useFuelKey();
  const [view, setView] = useState<View | null>(null);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [form, setForm] = useState({ name: "", endpoint_url: "", api_key: "", contact: "" });
  const [attest, setAttest] = useState(false);
  const [models, setModels] = useState<ModelRow[]>([{ ...blank }]);
  const [tick, setTick] = useState(0);
  const [rates, setRates] = useState<Map<string, Rate>>(new Map());

  // Live market rates, so sellers can see the price to beat while they fill in the form.
  useEffect(() => {
    let stale = false;
    fetch("/v1/market")
      .then((r) => r.json())
      .then((j: { data: Rate[] }) => {
        if (!stale) setRates(new Map(j.data.filter((r) => r.providers > 0).map((r) => [r.model, r])));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    if (!key) return;
    let stale = false;
    fuelCall<View>(key, "/v1/sellers/me")
      .then((v) => {
        if (stale) return;
        setView(v);
        const s = v.sellers[0];
        if (s) {
          setForm({ name: s.name, endpoint_url: s.endpoint_url, api_key: "", contact: s.contact ?? "" });
          setModels(
            s.models.map((m) => ({
              model: m.model,
              kind: m.kind === "embedding" ? "embedding" : "chat",
              provider_model_id: m.provider_model_id === m.model ? "" : m.provider_model_id,
              input_per_mtok: String(m.input_per_mtok),
              output_per_mtok: String(m.output_per_mtok),
            })),
          );
        }
      })
      .catch((e) => {
        if (!stale && String(e.message).toLowerCase().includes("api key")) saveKey(null);
      });
    return () => {
      stale = true;
    };
  }, [key, tick]);

  if (!key) {
    return (
      <div className="space-y-4 rounded-2xl border border-line bg-card p-5 sm:p-7">
        <p className="font-semibold">Sign in with the wallet you want to be paid to</p>
        <p className="text-sm text-muted">Your wallet (Solana or EVM) is your seller account. Earnings arrive in its Fuel balance.</p>
        <button
          onClick={async () => {
            setMsg(null);
            try {
              await connectWallet("seller");
            } catch (e) {
              setMsg({ text: (e as Error).message, bad: true });
            }
          }}
          className="w-full rounded-lg bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-strong"
        >
          Connect wallet
        </button>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (paste.trim()) saveKey(paste.trim());
          }}
        >
          <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="or paste a Fuel API key (fuel_sk_…)" className={`${input} font-mono`} />
          <button className="rounded-lg px-4 text-sm btn-2">Use</button>
        </form>
        {msg && <p className="text-sm text-bad">{msg.text}</p>}
      </div>
    );
  }

  const seller = view?.sellers[0];
  const setModel = (i: number, patch: Partial<ModelRow>) => setModels(models.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg({ text: "Saving and testing your endpoint…" });
    try {
      const v = await fuelCall<View & { probes: { model: string; ok: boolean; ms: number; error: string | null }[] }>(key, "/v1/sellers", {
        name: form.name,
        endpoint_url: form.endpoint_url,
        ...(form.api_key ? { api_key: form.api_key } : {}),
        contact: form.contact || null,
        attest,
        models: models
          .filter((m) => m.model.trim())
          .map((m) => ({
            model: m.model.trim(),
            kind: m.kind,
            ...(m.provider_model_id.trim() ? { provider_model_id: m.provider_model_id.trim() } : {}),
            input_per_mtok: Number(m.input_per_mtok),
            output_per_mtok: m.kind === "embedding" ? 0 : Number(m.output_per_mtok || 0),
          })),
      });
      const ok = v.probes.filter((p) => p.ok).length;
      setMsg({ text: `Saved. ${ok} of ${v.probes.length} model(s) answered the test. ${ok > 0 ? "Passing models are live now." : "Nothing is live yet: fix the errors below. It's re-tested every few minutes."}`, bad: ok === 0 });
      setForm({ ...form, api_key: "" });
      setTick((t) => t + 1);
    } catch (err) {
      setMsg({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {seller && (
        <div className="rounded-2xl border border-line bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">{seller.name}</p>
              <p className="font-mono text-xs text-muted">{seller.endpoint_url}</p>
            </div>
            <span className={`rounded-md px-2 py-1 text-xs font-medium capitalize ${STATUS[seller.status]}`}>{seller.status === "pending" ? "Waiting for a passing test" : seller.status === "approved" ? "Live" : seller.status}</span>
          </div>
          {seller.review_note && <p className="mt-3 text-sm text-muted">{seller.review_note}</p>}
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs text-faint">Jobs served</p>
              <p className="text-lg font-semibold tabular-nums">{seller.jobs_served}</p>
            </div>
            <div>
              <p className="text-xs text-faint">Earned (credit)</p>
              <p className="text-lg font-semibold tabular-nums">${view!.earned_usd.toFixed(4)}</p>
            </div>
            <div>
              <p className="text-xs text-faint">API key</p>
              <p className="text-lg font-semibold">{seller.has_api_key ? "Stored, encrypted" : "None"}</p>
            </div>
          </div>
          <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-white/50 text-sm">
            {seller.models.map((m) => (
              <li key={m.model} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="font-mono text-xs">{m.model}</span>
                <span className="text-xs text-muted">
                  ${m.input_per_mtok} in{m.kind === "chat" ? ` / $${m.output_per_mtok} out` : ""} per 1M
                </span>
                <span className={`text-xs ${m.probe_ok ? "text-ok" : "text-bad"}`}>
                  {m.probe_ok ? `✓ answered in ${m.probe_ms}ms` : `✗ ${m.probe_error ?? "not tested"}`}
                </span>
              </li>
            ))}
          </ul>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMsg({ text: "Re-testing…" });
              try {
                await fuelCall(key, "/v1/sellers/me/probe", {});
                setMsg({ text: "Tested again." });
                setTick((t) => t + 1);
              } catch (e) {
                setMsg({ text: (e as Error).message, bad: true });
              } finally {
                setBusy(false);
              }
            }}
            className="mt-4 rounded-lg px-4 py-2 text-sm btn-2"
          >
            Test again
          </button>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-card p-6">
        <p className="font-semibold">{seller ? "Update your listing" : "Apply to list your endpoint"}</p>
        {seller && <p className="text-xs text-muted">Saving re-tests every model. Passing models go live straight away.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-muted">Name</span>
            <input required minLength={2} maxLength={48} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme GPU" className={`mt-1 ${input}`} />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Contact (optional)</span>
            <input maxLength={120} value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="email, X or Telegram" className={`mt-1 ${input}`} />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-muted">Endpoint base URL</span>
            <input required value={form.endpoint_url} onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })} placeholder="https://gpu.example.com/v1" className={`mt-1 ${input} font-mono`} />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-muted">API key for Fuel {seller?.has_api_key && "(leave blank to keep the stored one)"}</span>
            <input type="password" autoComplete="off" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sk-…" className={`mt-1 ${input} font-mono`} />
          </label>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted">Models you serve · your price per 1M tokens (USD)</p>
          {models.map((m, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-line bg-white/40 p-3 sm:grid-cols-[1.6fr_0.8fr_0.7fr_0.7fr_auto]">
              <input required value={m.model} onChange={(e) => setModel(i, { model: e.target.value })} placeholder="openai/gpt-oss-120b" className={`${input} font-mono`} aria-label="Model name agents use" />
              <select value={m.kind} onChange={(e) => setModel(i, { kind: e.target.value as ModelRow["kind"] })} className={input} aria-label="Kind">
                <option value="chat">chat</option>
                <option value="embedding">embedding</option>
              </select>
              <input required inputMode="decimal" value={m.input_per_mtok} onChange={(e) => setModel(i, { input_per_mtok: e.target.value })} placeholder="in $" className={input} aria-label="Input price per 1M tokens" />
              <input
                inputMode="decimal"
                disabled={m.kind === "embedding"}
                value={m.kind === "embedding" ? "" : m.output_per_mtok}
                onChange={(e) => setModel(i, { output_per_mtok: e.target.value })}
                placeholder="out $"
                className={`${input} disabled:opacity-40`}
                aria-label="Output price per 1M tokens"
              />
              <button type="button" onClick={() => setModels(models.length > 1 ? models.filter((_, j) => j !== i) : [{ ...blank }])} className="text-xs text-muted hover:text-bad">
                Remove
              </button>
              <input
                value={m.provider_model_id}
                onChange={(e) => setModel(i, { provider_model_id: e.target.value })}
                placeholder="Name on your server, if different (optional)"
                className={`${input} font-mono text-xs sm:col-span-4`}
                aria-label="Model name on your server"
              />
              <PriceHint row={m} rate={rates.get(m.model.trim())} onUse={(inp, out) => setModel(i, { input_per_mtok: String(inp), output_per_mtok: String(out) })} />
            </div>
          ))}
          {models.length < 20 && (
            <button type="button" onClick={() => setModels([...models, { ...blank }])} className="text-sm font-medium text-accent hover:underline">
              + Add a model
            </button>
          )}
        </div>

        <label className="flex items-start gap-2 rounded-lg bg-white/50 p-3 text-sm">
          <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-0.5" required />
          <span>
            I run this compute myself, or have the right to resell it. It isn&apos;t a resold commercial model API (OpenAI, Anthropic, Google, Together and the like
            can&apos;t be listed).
          </span>
        </label>
        <button disabled={busy || !attest} className="w-full rounded-lg bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-strong disabled:opacity-50">
          {busy ? "Working…" : seller ? "Save and re-test" : "Apply and test my endpoint"}
        </button>
        {msg && <p className={`text-sm ${msg.bad ? "text-bad" : "text-muted"}`}>{msg.text}</p>}
      </form>
    </div>
  );
}

function PriceHint({ row, rate, onUse }: { row: ModelRow; rate?: Rate; onUse: (inp: number, out: number) => void }) {
  if (!row.model.trim()) return null;
  if (!rate) {
    return (
      <p className="text-xs text-muted sm:col-span-5">
        No one sells <span className="font-mono">{row.model.trim()}</span> on Fuel yet, so your price sets the market. Compare similar models on the{" "}
        <a href="/market" className="text-accent underline" target="_blank" rel="noreferrer">
          market page
        </a>
        .
      </p>
    );
  }
  const yourIn = Number(row.input_per_mtok);
  const yourOut = Number(row.output_per_mtok || 0);
  const typed = row.input_per_mtok !== "";
  const wins = typed && yourIn * 3 + (row.kind === "chat" ? yourOut : 0) < rate.low.in * 3 + (row.kind === "chat" ? rate.low.out : 0);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-white/60 px-2.5 py-1.5 text-xs sm:col-span-5">
      <span className="text-muted">
        Price to beat: <span className="font-semibold text-ink">{money(rate.low.in)}</span>
        {row.kind === "chat" && (
          <>
            {" "}
            in / <span className="font-semibold text-ink">{money(rate.low.out)}</span> out
          </>
        )}{" "}
        · {rate.providers} provider{rate.providers === 1 ? "" : "s"}
      </span>
      {typed && <span className={wins ? "text-ok" : "text-bad"}>{wins ? "You'd be the cheapest: jobs come to you" : "Above the current low: you'd get jobs only as a backup"}</span>}
      <button type="button" onClick={() => onUse(rate.to_win.in, rate.to_win.out)} className="ml-auto font-medium text-accent hover:underline">
        Use suggested ({money(rate.to_win.in)}
        {row.kind === "chat" ? ` / ${money(rate.to_win.out)}` : ""})
      </button>
    </div>
  );
}
