"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFuelKey } from "@/components/fuel-key";
import { useAccount } from "@/app/studio/trial";

// The ★ pick depends on how you run: signed in with a wallet gets the best model overall;
// visitors (free trial) get the best model the trial covers, and paid-only models are locked.
const PAID = [
  ["anthropic/claude-fable-5-2", "★ Claude Fable 5.2 · best"],
  ["anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["anthropic/claude-haiku-5-5", "Claude Haiku 5.5 · fastest"],
  ["openai/gpt-oss-120b", "gpt-oss-120b · low cost"],
] as const;
const TRIAL = [
  ["openai/gpt-oss-120b", "★ gpt-oss-120b · best on free trial"],
  ["anthropic/claude-haiku-5-5", "Claude Haiku 5.5 · fastest"],
] as const;
const LOCKED = [
  ["anthropic/claude-fable-5-2", "Claude Fable 5.2 · sign in to use"],
  ["anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5 · sign in to use"],
] as const;

const EXAMPLES = ["Write a haiku about cheap compute", "Explain x402 in one paragraph", "Three names for an AI agent that trades"];

/** Home-page command bar: opens the studio with the prompt and model filled in. */
export default function TryBox() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const key = useFuelKey();
  const acct = useAccount(key);
  const paid = !!key && !!acct && !acct.wallet.startsWith("guest:");
  const [picked, setModel] = useState<string | null>(null);
  const model = picked ?? (paid ? PAID[0][0] : TRIAL[0][0]);
  const go = (text: string) => {
    // The studio shares one prompt across its tabs; the prompt from here replaces it.
    try {
      sessionStorage.setItem("fuel.studio.draft.prompt", text.slice(0, 2000));
    } catch {}
    router.push(`/studio?tab=text&model=${encodeURIComponent(model)}&prompt=${encodeURIComponent(text.slice(0, 2000))}`);
  };

  return (
    <div className="rounded-3xl border border-line bg-card p-3 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.35)] sm:p-4">
      <div className="flex items-center justify-between gap-3 px-1 pb-3">
        <p className="text-sm font-semibold tracking-tight">
          Try a prompt <span className="font-normal text-muted">{paid ? "· runs on your balance, receipt included" : "· free, no sign-up, receipt included"}</span>
        </p>
        <Link href="/models" className="hidden shrink-0 text-xs font-medium text-muted hover:text-ink sm:block">
          All models →
        </Link>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(prompt.trim() || EXAMPLES[0]);
        }}
        className="flex flex-col gap-2 rounded-2xl border border-line-strong bg-white/80 p-1.5 focus-within:border-ink/40 sm:flex-row sm:items-center sm:gap-1"
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask anything…"
          aria-label="Prompt"
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-base outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-1.5">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Model"
            className="min-w-0 flex-1 cursor-pointer rounded-xl border border-line bg-white px-3 py-2 font-mono text-xs text-muted outline-none hover:text-ink sm:flex-none"
          >
            {(paid ? PAID : TRIAL).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
            {!paid &&
              LOCKED.map(([id, label]) => (
                <option key={id} value={id} disabled>
                  {label}
                </option>
              ))}
          </select>
          <button className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong">Run ↵</button>
        </div>
      </form>
      <div className="flex gap-2 overflow-x-auto px-1 pt-3 [scrollbar-width:none] sm:flex-wrap [&::-webkit-scrollbar]:hidden">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" onClick={() => setPrompt(ex)} className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink">
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
