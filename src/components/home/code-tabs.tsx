"use client";

import { useState } from "react";

// The one dark band on the page: code in three languages, ending in the receipt.

export default function CodeTabs({ base }: { base: string }) {
  const snippets = {
    Python: `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="fuel_sk_...",
)

r = client.chat.completions.create(
    model="openai/gpt-oss-120b",
    messages=[{"role": "user", "content": "Summarise this thread"}],
)
print(r.choices[0].message.content)
print(r.model_extra["fuel"])`,
    Node: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: "fuel_sk_...",
});

const r = await client.chat.completions.create({
  model: "openai/gpt-oss-120b",
  messages: [{ role: "user", content: "Summarise this thread" }],
});
console.log(r.choices[0].message.content, r.fuel);`,
    curl: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer fuel_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"openai/gpt-oss-120b",
       "messages":[{"role":"user","content":"Summarise this thread"}]}'`,
  };
  type Lang = keyof typeof snippets;
  const [lang, setLang] = useState<Lang>("Python");
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#2f2f2f] shadow-2xl shadow-black/30">
      <div className="flex items-center justify-between border-b border-white/10 px-3">
        <div role="tablist" className="flex">
          {(Object.keys(snippets) as Lang[]).map((l) => (
            <button
              key={l}
              role="tab"
              aria-selected={lang === l}
              onClick={() => setLang(l)}
              className={`border-b-2 px-3 py-2.5 text-xs font-medium ${lang === l ? "border-white text-white" : "border-transparent text-white/50 hover:text-white/80"}`}
            >
              {l}
            </button>
          ))}
        </div>
        <button onClick={() => navigator.clipboard?.writeText(snippets[lang])} className="text-xs text-white/50 hover:text-white">
          Copy
        </button>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-relaxed text-white/85">
        <code>{snippets[lang]}</code>
      </pre>
      <div className="border-t border-white/10 bg-black/20 px-5 py-3 font-mono text-[11.5px] text-white/60">
        <span className="text-white/40">receipt → </span>
        {'{ "provider": "together", "price_usd": 0.000044, "latency_ms": 897, "attempts": 1 }'}
      </div>
    </div>
  );
}
