// Quality and speed labels for models, shown as small badges in the studio and catalog.
// Quality is Fuel's judgement within each kind (a "Draft" picture model is great for drafts);
// speed comes from measured run times, with thresholds per kind.

export type Quality = "Basic" | "Draft" | "Good" | "High" | "Best";
export type Speed = "Fast" | "Medium" | "Slow";

const SPEED_LIMITS: Record<string, [number, number]> = {
  image: [5, 15],
  video: [90, 240],
  mesh: [90, 180],
  speech: [10, 30],
  transcription: [15, 45],
};

/** Speed from a model's typical run time (seconds) for its kind. */
export function speedOf(kind: string, typicalSeconds: number | null | undefined): Speed | null {
  const lim = SPEED_LIMITS[kind];
  if (!lim || !typicalSeconds) return null;
  return typicalSeconds <= lim[0] ? "Fast" : typicalSeconds <= lim[1] ? "Medium" : "Slow";
}

/** Chat models: quality and speed by family and size (general guidance, not a benchmark). */
const CHAT: [RegExp, Quality, Speed][] = [
  [/claude-(opus|fable)/, "Best", "Medium"],
  [/claude-sonnet/, "High", "Medium"],
  [/claude-haiku/, "Good", "Fast"],
  [/gpt-oss-120b|kimi|deepseek-v4-pro|glm-5\.3$|glm-5\.2|muse-spark|beam|inkling$/i, "High", "Medium"],
  [/flash|-mini|small|nano|lite/i, "Good", "Fast"],
  [/\b(1\.5b|3b|4b|7b|8b|9b)\b|-(1\.5|3|4|7|8|9)b|tev1/i, "Basic", "Fast"],
];

export function chatLabels(model: string): { quality: Quality; speed: Speed } {
  for (const [re, quality, speed] of CHAT) if (re.test(model)) return { quality, speed };
  return { quality: "Good", speed: "Medium" };
}

/**
 * One recommended model per category: the best quality Fuel offers in it. Every model picker opens
 * on it. Cheaper and faster options are labelled too, so people can trade down knowingly.
 */
export const RECOMMENDED: Record<string, string> = {
  chat: "anthropic/claude-fable-5-2",
  image: "black-forest-labs/FLUX.1.1-pro",
  video: "minimax/hailuo-02",
  mesh: "tencent/Hunyuan3D-2",
  speech: "minimax/speech-02-hd",
  transcription: "openai/whisper",
};
export const isRecommended = (kind: string, model: string) => RECOMMENDED[kind] === model;

export type Tag = "cheapest" | "fastest";
const RANK: Record<Quality, number> = { Basic: 0, Draft: 1, Good: 2, High: 3, Best: 4 };
const typicalPerM = (m: { inPerM: number; outPerM: number }) => (m.inPerM * 3 + m.outPerM) / 4;

/** Cheapest and fastest chat models. Fastest = the best-quality model rated Fast (ties: cheaper). */
export function chatTags(models: { id: string; inPerM: number; outPerM: number }[]): Record<string, Tag[]> {
  const out: Record<string, Tag[]> = {};
  const add = (id: string | undefined, t: Tag) => id && (out[id] = [...(out[id] ?? []), t]);
  const priced = models.filter((m) => m.inPerM > 0 || m.outPerM > 0);
  add([...priced].sort((a, b) => typicalPerM(a) - typicalPerM(b))[0]?.id, "cheapest");
  const fast = models.filter((m) => chatLabels(m.id).speed === "Fast");
  add([...fast].sort((a, b) => RANK[chatLabels(b.id).quality] - RANK[chatLabels(a.id).quality] || typicalPerM(a) - typicalPerM(b))[0]?.id, "fastest");
  return out;
}

/** Cheapest and fastest in one media category (by price per unit and measured run time). */
export function mediaTags(list: { model: string; priceUsd: number; typicalSeconds: number | null }[]): Record<string, Tag[]> {
  const out: Record<string, Tag[]> = {};
  const add = (id: string | undefined, t: Tag) => id && (out[id] = [...(out[id] ?? []), t]);
  add([...list].sort((a, b) => a.priceUsd - b.priceUsd)[0]?.model, "cheapest");
  add([...list].filter((m) => m.typicalSeconds).sort((a, b) => (a.typicalSeconds ?? 1e9) - (b.typicalSeconds ?? 1e9))[0]?.model, "fastest");
  return out;
}

/** Free-trial guests: the best-quality chat model the trial covers (up to $1 per 1M tokens typical). */
export function bestTrialChat(models: { id: string; inPerM: number; outPerM: number }[]) {
  return [...models].filter((m) => typicalPerM(m) <= 1).sort((a, b) => RANK[chatLabels(b.id).quality] - RANK[chatLabels(a.id).quality] || typicalPerM(a) - typicalPerM(b))[0]?.id ?? null;
}
export const TRIAL_PICTURE = "black-forest-labs/FLUX.1-schnell";
/** The free trial's model for each media feature, and its per-trial limit (mirrors lib/guest.ts). */
export const TRIAL_MEDIA: Record<string, { model: string; limit: string | null }> = {
  image: { model: TRIAL_PICTURE, limit: null },
  video: { model: "Lightricks/LTX-Video", limit: "2 clips" },
  mesh: { model: "microsoft/TRELLIS", limit: "2 3D models" },
  speech: { model: "hexgrad/Kokoro-82M", limit: "5 voice clips, up to 500 characters each" },
  transcription: { model: "openai/whisper", limit: "2 transcriptions" },
};

/** Whether the no-wallet free trial covers a model (mirrors the server's rule in lib/guest.ts). */
export function trialCovers(kind: string, model: string, price?: { inPerM: number; outPerM: number }) {
  if (kind === "chat") return !!price && typicalPerM(price) <= 1;
  return TRIAL_MEDIA[kind]?.model === model;
}

export const QUALITY_TONE: Record<Quality, string> = {
  Basic: "border-line text-muted",
  Draft: "border-line text-muted",
  Good: "border-line text-ink",
  High: "border-accent/40 text-ink",
  Best: "border-accent bg-accent text-white",
};
