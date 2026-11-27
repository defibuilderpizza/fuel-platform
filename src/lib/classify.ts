import "server-only";
import { apiError } from "@/lib/http";
import type { Caller } from "@/lib/auth";
import { LANE, laneVectors } from "@/lib/lane";
import { LANE_MODEL, cosine } from "@/lib/lane-crypto";

// Zero-shot classification on the laptop lane. The texts and one sentence per label are embedded
// by laptops (cross-checked by two, with hidden canaries, exactly like embedding jobs), then Fuel
// ranks the labels for each text by cosine similarity. Deterministic, so the result is verifiable.

const SCALE = 50; // softmax temperature 1/50: bge cosine scores sit in a narrow band
const MAX_LABELS = 20;

type Body = { model?: unknown; input?: unknown; labels?: unknown; hypothesis_template?: unknown };

export async function runClassification(caller: Caller, body: Body): Promise<Response> {
  if (body.model !== undefined && body.model !== LANE_MODEL) {
    return apiError(400, "invalid_request_error", `Classification runs on the laptop lane: use model '${LANE_MODEL}' (or leave it out).`);
  }
  const inputs = typeof body.input === "string" ? [body.input] : Array.isArray(body.input) && body.input.every((x) => typeof x === "string") ? (body.input as string[]) : null;
  if (!inputs?.length) return apiError(400, "invalid_request_error", "'input' must be a string or an array of strings.");
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === "string" && l.trim().length > 0).map((l) => l.trim()) : [];
  if (labels.length < 2 || labels.length > MAX_LABELS || new Set(labels).size !== labels.length || labels.some((l) => l.length > 200)) {
    return apiError(400, "invalid_request_error", `'labels' must be 2–${MAX_LABELS} different strings (up to 200 characters each).`);
  }
  const template = typeof body.hypothesis_template === "string" ? body.hypothesis_template : "This text is about {}.";
  if (!template.includes("{}") || template.length > 200) return apiError(400, "invalid_request_error", "'hypothesis_template' must contain {} where the label goes.");
  if (inputs.length + labels.length > LANE.maxInputs) {
    return apiError(400, "invalid_request_error", `Texts plus labels can be up to ${LANE.maxInputs} per request (you sent ${inputs.length} + ${labels.length}).`);
  }

  const r = await laneVectors(caller, [...inputs, ...labels.map((l) => template.replace("{}", l))]);
  if (r instanceof Response) return r;
  const textVecs = r.vectors.slice(0, inputs.length);
  const labelVecs = r.vectors.slice(inputs.length);

  const data = textVecs.map((v, index) => {
    const sims = labelVecs.map((l) => cosine(v, l));
    const max = Math.max(...sims);
    const exps = sims.map((x) => Math.exp((x - max) * SCALE));
    const total = exps.reduce((a, b) => a + b, 0);
    const ranked = labels
      .map((label, i) => ({ label, score: Math.round((exps[i] / total) * 10_000) / 10_000, similarity: Math.round(sims[i] * 10_000) / 10_000 }))
      .sort((a, b) => b.similarity - a.similarity);
    return { object: "classification", index, label: ranked[0].label, scores: ranked };
  });
  return Response.json({ object: "list", model: LANE_MODEL, data, fuel: r.receipt }, { headers: { "x-fuel-job-id": r.receipt.job_id } });
}
