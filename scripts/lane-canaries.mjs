// Generates the laptop-lane canaries: fixed inputs with known embeddings. Fuel slips one into
// some tasks; a laptop whose answer for it is wrong gets a strike (catches made-up results,
// including two colluding laptops returning the same junk).
// Run: node scripts/lane-canaries.mjs   (writes src/lib/lane-canaries.json)
import { writeFileSync } from "node:fs";
import { pipeline } from "@huggingface/transformers";

const MODEL = "Xenova/bge-small-en-v1.5";
const inputs = [
  "The weather forecast calls for light rain in the afternoon.",
  "Solana processes thousands of transactions per second.",
  "A recipe for banana bread with walnuts and cinnamon.",
  "The committee approved the budget after a long debate.",
  "Mountain bikes need wider tyres for loose gravel trails.",
  "Photosynthesis converts sunlight into chemical energy.",
  "Our quarterly revenue grew by twelve percent year over year.",
  "The museum opens a new exhibit on ancient navigation tools.",
  "Reset your password using the link we emailed you.",
  "Jazz musicians often improvise over a chord progression.",
  "The train to the airport leaves every fifteen minutes.",
  "Neural networks learn by adjusting weights to reduce error.",
];
const ex = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
const out = (await ex(inputs, { pooling: "cls", normalize: true })).tolist();
const canaries = inputs.map((text, i) => ({ text, vector: out[i].map((x) => Math.round(x * 1e6) / 1e6) }));
writeFileSync("src/lib/lane-canaries.json", JSON.stringify({ model: MODEL, dtype: "q8", pooling: "cls", canaries }) + "\n");
console.log(`wrote ${canaries.length} canaries (${out[0].length} dims)`);
process.exit(0);
