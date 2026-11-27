// Offline test of the Claude adapter's translation (no API key needed):
//   npx tsx --conditions=react-server scripts/anthropic-adapter-test.mts
const mod: any = await import("../src/lib/anthropic.ts");
const { toAnthropicRequest, fromAnthropicResponse, callAnthropic } = mod.callAnthropic ? mod : mod.default;

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

// Request: system hoisted, turns merged, tools + tool results translated, Claude 5 sampling dropped
const req = toAnthropicRequest(
  {
    max_tokens: 300,
    temperature: 0.2,
    stop: ["END"],
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: "Use tools." },
      { role: "user", content: "Weather?" },
      { role: "user", content: [{ type: "text", text: "In Paris." }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "18C" },
    ],
    tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
    tool_choice: "required",
  },
  "claude-sonnet-5-5",
) as Record<string, any>;
check("system + developer hoisted", req.system === "Be brief.\nUse tools.");
check("consecutive user turns merged", req.messages[0].role === "user" && req.messages[0].content.length === 2);
check("assistant tool call → tool_use", req.messages[1].content[0].type === "tool_use" && req.messages[1].content[0].input.city === "Paris");
check("tool result → user tool_result", req.messages[2].role === "user" && req.messages[2].content[0].type === "tool_result" && req.messages[2].content[0].tool_use_id === "call_1");
check("tools + tool_choice translated", req.tools[0].input_schema.properties.city && req.tool_choice.type === "any");
check("max_tokens + stop_sequences", req.max_tokens === 300 && req.stop_sequences[0] === "END");
check("Claude 5: temperature left out", req.temperature === undefined);
const old = toAnthropicRequest({ temperature: 1.7, messages: [{ role: "user", content: "hi" }] }, "claude-3-haiku") as Record<string, any>;
check("older Claude: temperature clamped to 1", old.temperature === 1 && old.max_tokens === 4096);

// Response
const res = fromAnthropicResponse(
  {
    id: "msg_1",
    content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "It's 18C." }, { type: "tool_use", id: "t1", name: "x", input: { a: 1 } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
  },
  "claude-sonnet-5-5",
) as Record<string, any>;
check("text kept, thinking dropped", res.choices[0].message.content === "It's 18C.");
check("tool_use → tool_calls", res.choices[0].message.tool_calls[0].function.arguments === '{"a":1}' && res.choices[0].finish_reason === "tool_calls");
check("usage includes cached input", res.usage.prompt_tokens === 15 && res.usage.completion_tokens === 7);

// Streaming: feed a synthetic Claude SSE stream through callAnthropic via a stubbed fetch
const sse = [
  { type: "message_start", message: { id: "msg_s", usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "f" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
  { type: "message_stop" },
]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join("");
let sentBody: any = null;
globalThis.fetch = (async (_u: string, init: RequestInit) => {
  sentBody = JSON.parse(String(init.body));
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;
const out = await callAnthropic("test-key", "claude-haiku-5-5", { stream: true, messages: [{ role: "user", content: "hi" }] }, new AbortController().signal);
const text = await out.text();
const events = text.split("\n\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
const content = events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");
const args = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []).map((t: any) => t.function?.arguments ?? "").join("");
const usage = events.find((e) => e.usage)?.usage;
check("request sent with stream: true to Claude", sentBody.stream === true && sentBody.model === "claude-haiku-5-5");
check("stream: text deltas → OpenAI content chunks", content === "Hello", content);
check("stream: tool input deltas → tool_calls arguments", args === '{"q":1}', args);
check("stream: finish_reason + final usage chunk", events.some((e) => e.choices?.[0]?.finish_reason === "stop") && usage?.prompt_tokens === 12 && usage?.completion_tokens === 9, JSON.stringify(usage));
check("stream ends with [DONE]", text.trim().endsWith("data: [DONE]"));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
