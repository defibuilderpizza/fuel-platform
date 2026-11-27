// Plain-English labels for the model catalog. Matched on the model id; anything unknown gets a
// neutral line from its kind. Keep these general: prices and context come from live data.

export type ModelKind = "chat" | "embedding";
export type ModelCard = {
  id: string;
  kind: ModelKind;
  maker: string;
  name: string;
  blurb: string;
  tags: string[];
  inPerM: number;
  outPerM: number;
  context: number | null;
  providers: number;
};

const FAMILIES: [RegExp, string, string[]][] = [
  [/anthropic\/claude-(fable|opus)/, "Anthropic's top Claude models, for the hardest reasoning, coding and agent work.", ["closed", "top tier"]],
  [/anthropic\/claude-sonnet/, "Claude for everyday heavy lifting: strong at code, writing and tool use, at a middle price.", ["closed"]],
  [/anthropic\/claude-haiku/, "Claude's fast, low-cost model for high-volume and quick tasks.", ["closed", "fast"]],
  [/openai\/gpt-oss/, "OpenAI's open-weight model: capable general chat and reasoning at an open-model price.", ["open-weight"]],
  [/openai\//, "OpenAI GPT.", ["closed"]],
  [/deepseek/i, "DeepSeek open-weight models: strong reasoning and code for the price.", ["open-weight"]],
  [/qwen/i, "Alibaba's Qwen open-weight family, good all-rounders for chat and code.", ["open-weight"]],
  [/kimi|moonshot/i, "Moonshot's Kimi: large open-weight models built for long, agentic work.", ["open-weight", "large"]],
  [/glm|zai-org/i, "Z.ai's GLM open-weight models for chat, code and tool use.", ["open-weight"]],
  [/minimax/i, "MiniMax open-weight models with very long context.", ["open-weight", "long context"]],
  [/nemotron|nvidia/i, "NVIDIA Nemotron open-weight models, tuned for instruction following.", ["open-weight"]],
  [/llama|meta-models|muse/i, "Open-weight models from Meta's family.", ["open-weight"]],
  [/fuel-lane/, "Embeddings run on volunteers' laptops and cross-checked. The cheapest way to embed text; laptops see the text.", ["laptop lane", "cheapest"]],
];

export function describe(id: string, kind: ModelKind) {
  const [maker, ...rest] = id.split("/");
  const name = rest.join("/") || id;
  const fam = FAMILIES.find(([re]) => re.test(id));
  const blurb = fam?.[1] ?? (kind === "embedding" ? "Turns text into vectors for search, clustering and retrieval." : "An open-weight chat model served by Fuel's providers.");
  const tags = [kind === "embedding" ? "embeddings" : "chat", ...(fam?.[2] ?? [])];
  return { maker, name, blurb, tags };
}
