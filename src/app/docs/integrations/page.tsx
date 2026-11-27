import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow } from "@/components/ui";
import CopyBlock from "./copy-block";

export const metadata: Metadata = {
  title: "Integrations",
  description: "Use Fuel from the OpenAI SDK, Vercel AI SDK, LangChain, LlamaIndex, CrewAI or curl. One base URL change.",
};

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://fuelai.cloud";
const BASE = `${SITE}/v1`;
const MODEL = "openai/gpt-oss-120b";

const ITEMS: { id: string; name: string; lang: string; install: string; code: string; note?: string }[] = [
  {
    id: "openai-python",
    name: "OpenAI SDK (Python)",
    lang: "python",
    install: "pip install openai",
    code: `from openai import OpenAI

client = OpenAI(base_url="${BASE}", api_key="fuel_sk_...")
r = client.chat.completions.create(
    model="${MODEL}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)
print(r.model_extra["fuel"])  # receipt: provider, price_usd, tokens`,
  },
  {
    id: "openai-node",
    name: "OpenAI SDK (Node)",
    lang: "ts",
    install: "npm i openai",
    code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${BASE}", apiKey: process.env.FUEL_API_KEY });
const r = await client.chat.completions.create({
  model: "${MODEL}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content);`,
  },
  {
    id: "vercel-ai",
    name: "Vercel AI SDK",
    lang: "ts",
    install: "npm i ai @ai-sdk/openai-compatible",
    code: `import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const fuel = createOpenAICompatible({ name: "fuel", baseURL: "${BASE}", apiKey: process.env.FUEL_API_KEY });
const { text } = await generateText({ model: fuel("${MODEL}"), prompt: "Hello" });`,
  },
  {
    id: "langchain",
    name: "LangChain (Python)",
    lang: "python",
    install: "pip install langchain-openai",
    code: `from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="${MODEL}", base_url="${BASE}", api_key="fuel_sk_...")
print(llm.invoke("Hello").content)`,
    note: "LangChain JS: new ChatOpenAI({ model, apiKey, configuration: { baseURL } }).",
  },
  {
    id: "llamaindex",
    name: "LlamaIndex",
    lang: "python",
    install: "pip install llama-index-llms-openai-like",
    code: `from llama_index.llms.openai_like import OpenAILike

llm = OpenAILike(model="${MODEL}", api_base="${BASE}", api_key="fuel_sk_...", is_chat_model=True)
print(llm.complete("Hello"))`,
  },
  {
    id: "crewai",
    name: "CrewAI",
    lang: "python",
    install: "pip install crewai",
    code: `from crewai import Agent, LLM

# "openai/" tells CrewAI (via LiteLLM) to use the OpenAI-compatible protocol
llm = LLM(model="openai/${MODEL}", base_url="${BASE}", api_key="fuel_sk_...")
researcher = Agent(role="Researcher", goal="Find facts", backstory="Careful", llm=llm)`,
  },
  {
    id: "openai-agents",
    name: "OpenAI Agents SDK",
    lang: "python",
    install: "pip install openai-agents",
    code: `import asyncio
from agents import Agent, Runner, AsyncOpenAI, OpenAIChatCompletionsModel, set_tracing_disabled

set_tracing_disabled(True)  # tracing needs an OpenAI platform key
client = AsyncOpenAI(base_url="${BASE}", api_key="fuel_sk_...")
agent = Agent(
    name="Researcher",
    instructions="Answer briefly.",
    model=OpenAIChatCompletionsModel(model="${MODEL}", openai_client=client),
)
print(asyncio.run(Runner.run(agent, "Hello")).final_output)`,
    note: "The successor to OpenAI's Swarm. Handoffs between agents work the same way: give each agent the Fuel model.",
  },
  {
    id: "swarms",
    name: "Swarms",
    lang: "python",
    install: "pip install swarms",
    code: `from swarms import Agent

agent = Agent(
    agent_name="Researcher",
    model_name="openai/${MODEL}",   # "openai/" = OpenAI-compatible endpoint
    llm_base_url="${BASE}",
    llm_api_key="fuel_sk_...",
    max_loops=1,
)
print(agent.run("Hello"))`,
    note: "Follows the Swarms docs (llm_base_url / llm_api_key); not yet run against Fuel by us.",
  },
  {
    id: "claude-sdk",
    name: "Claude SDK (Anthropic format)",
    lang: "ts",
    install: "npm i @anthropic-ai/sdk",
    code: `import Anthropic from "@anthropic-ai/sdk";

// Fuel speaks Anthropic's Messages format too: Claude or open models
const client = new Anthropic({ baseURL: "${SITE}", apiKey: process.env.FUEL_API_KEY });
const msg = await client.messages.create({
  model: "claude-sonnet-5-5",          // or "openai/gpt-oss-120b", "Qwen/Qwen3.5-9B", …
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});`,
    note: "Streaming and tool use work. Bare Claude ids map to anthropic/…; any Fuel model id works.",
  },
  {
    id: "curl",
    name: "curl",
    lang: "bash",
    install: "",
    code: `curl ${BASE}/chat/completions \\
  -H "Authorization: Bearer fuel_sk_..." -H "Content-Type: application/json" \\
  -d '{"model":"${MODEL}","messages":[{"role":"user","content":"Hello"}]}'`,
  },
];

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 sm:space-y-12 px-4 py-8 sm:py-14">
      <section className="max-w-3xl space-y-3">
        <Eyebrow>Integrations</Eyebrow>
        <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Works with what your agent already uses</h1>
        <p className="text-[15px] text-muted sm:text-lg">
          Fuel speaks the OpenAI API. Point your framework at <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-base text-ink">{BASE}</code>, use a Fuel key,
          and every job runs on the cheapest healthy compute, paid from the agent&apos;s own wallet.
        </p>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="min-w-0 space-y-4 rounded-3xl border border-line bg-card p-5 sm:p-7">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">Starter kit</p>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Give an agent its own wallet in one command</h2>
          <p className="text-sm text-muted">
            The quickstart creates a Solana wallet for the agent (or uses yours), signs in, checks the balance, claims the free trial credits (any wallet, once), and runs a
            first job. Signing in never sends a transaction.
          </p>
          <CopyBlock lang="bash" code={`curl -O ${SITE}/starter/quickstart.mjs\nnpm i @noble/curves bs58 openai\nnode quickstart.mjs`} />
          <CopyBlock lang="bash" code={`curl -O ${SITE}/starter/quickstart.py\npip install pynacl base58 openai requests\npython quickstart.py`} />
          <p className="text-xs text-muted">
            Set <code className="font-mono">FUEL_KEYPAIR</code> to use an existing Solana keypair file. Fund the agent by sending USDC or SOL from its wallet to the deposit
            address it prints.
          </p>
        </div>
        <div className="min-w-0 space-y-4 rounded-3xl border border-line bg-card p-5 sm:p-7">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">For agents and tools</p>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Machine-readable</h2>
          <ul className="space-y-3 text-sm">
            {[
              ["/llms.txt", "Plain-text guide for agents that read sites: sign-in, top-ups, live model prices"],
              ["/openapi.json", "OpenAPI 3.1 spec: import into tools, SDK generators and API directories"],
              ["/v1/models", "Every model with Fuel's price per 1M tokens"],
              ["/v1/status", "Live system status"],
            ].map(([p, d]) => (
              <li key={p} className="flex gap-3">
                <a href={p} className="shrink-0 font-mono text-ink underline-offset-2 hover:underline">
                  {p}
                </a>
                <span className="text-muted">{d}</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-line pt-4 text-xs text-muted">
            Getting a key by hand: <Link href="/dashboard" className="font-medium text-ink hover:underline">sign in on the dashboard</Link> with Phantom, Solflare or Backpack.
          </p>
        </div>
      </section>

      <section id="x402" className="scroll-mt-24 space-y-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">x402</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">Pay per request, no account</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            Any x402 client can use Fuel with no sign-up and no top-up. Call a compute endpoint without an Authorization header and Fuel answers{" "}
            <code className="font-mono">402</code> with a <code className="font-mono">PAYMENT-REQUIRED</code> header: the job&apos;s price ceiling in USDC on Solana (x402 v2, scheme
            exact, at least $0.01). Sign the USDC transfer with the agent&apos;s wallet and send the same request again with <code className="font-mono">PAYMENT-SIGNATURE</code>. Fuel pays the
            network fee, settles the payment, runs the job as that wallet and returns <code className="font-mono">PAYMENT-RESPONSE</code> with the result. Whatever the job didn&apos;t use stays in
            the wallet&apos;s Fuel balance, and a failed job costs nothing.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["Works on", "/v1/chat/completions, /v1/embeddings, /v1/images/generations, /v1/videos and /v1/3d"],
            ["Pays in", "USDC on Solana mainnet, to Fuel's deposit wallet; Fuel sponsors the network fee"],
            ["Each payment", "Pays for one request. Reusing a signed payment is refused"],
          ].map(([t, b]) => (
            <div key={t} className="rounded-2xl border border-line bg-card p-5 text-sm">
              <p className="font-semibold">{t}</p>
              <p className="mt-1 text-muted">{b}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="plugins" className="scroll-mt-24 space-y-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">Agent framework plugins</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">Agents that manage their own compute</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Beyond a base URL: these let an agent check its balance, see prices, run jobs and top up from its own wallet. On npm now.{" "}
            <a href="https://github.com/defibuilderpizza/fuel-integrations" target="_blank" rel="noreferrer" className="font-medium text-ink underline underline-offset-2">Source on GitHub ↗</a>
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["ElizaOS", "@fuelcompute/plugin-elizaos", "Fuel as the model provider + balance and price actions"],
            ["GOAT", "@fuelcompute/goat-plugin", "Balance, prices, completions and capped top-ups as tools"],
            ["Solana Agent Kit", "@fuelcompute/solana-agent-kit-plugin", "Methods and actions for v2 agents"],
            ["MCP", "@fuelcompute/mcp", "Claude Desktop, Claude Code, Cursor, any MCP client: npx -y @fuelcompute/mcp"],
            ["TypeScript SDK", "@fuelcompute/sdk", "Wallet sign-in, jobs, market data, credits"],
          ].map(([n, pkg, d]) => (
            <a key={n} href={`https://www.npmjs.com/package/${pkg}`} target="_blank" rel="noreferrer" className="lift block rounded-2xl border border-line bg-card p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold tracking-tight">{n}</p>
                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">npm</span>
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-faint">npm i {pkg}</p>
              <p className="mt-2 text-xs text-muted">{d}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex flex-wrap gap-2">
          {ITEMS.map((i) => (
            <a key={i.id} href={`#${i.id}`} className="rounded-lg px-3 py-1.5 text-sm font-medium btn-2">
              {i.name}
            </a>
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {ITEMS.map((i) => (
            <div key={i.id} id={i.id} className="min-w-0 scroll-mt-24 space-y-3 rounded-2xl border border-line bg-card p-4 sm:p-6">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-semibold tracking-tight">{i.name}</h3>
                {i.install && <code className="truncate font-mono text-xs text-muted">{i.install}</code>}
              </div>
              <CopyBlock lang={i.lang} code={i.code} />
              {i.note && <p className="text-xs text-muted">{i.note}</p>}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
