import "server-only";

// Native Anthropic (Claude) adapter. Fuel speaks OpenAI chat-completions internally; this turns an
// OpenAI-format request into a Claude Messages API call and the reply (JSON or SSE stream) back
// into OpenAI format, so routing, billing, receipts and failover work unchanged.
// (Anthropic's own OpenAI-compatibility layer isn't meant for production, so we don't use it.)

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

type OAContentPart = {
  type: string;
  text?: string;
  image_url?: { url: string } | string;
};
type OAMessage = {
  role: string;
  content?: string | OAContentPart[] | null;
  tool_calls?: {
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
};
type AnBlock = Record<string, unknown>;
type AnMessage = { role: "user" | "assistant"; content: AnBlock[] };

function partsToBlocks(content: OAMessage["content"]): AnBlock[] {
  if (content == null) return [];
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : [];
  const out: AnBlock[] = [];
  for (const p of content) {
    if (p.type === "text" && p.text) out.push({ type: "text", text: p.text });
    if (p.type === "image_url") {
      const url =
        typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (!url) continue;
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      out.push(
        m
          ? {
              type: "image",
              source: { type: "base64", media_type: m[1], data: m[2] },
            }
          : { type: "image", source: { type: "url", url } },
      );
    }
  }
  return out;
}

const textOf = (content: OAMessage["content"]) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("")
      : "";

/** Claude 5-generation models reject non-default sampling params while thinking; leave them out. */
const isClaude5 = (model: string) =>
  /claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model);

export function toAnthropicRequest(
  body: Record<string, unknown>,
  model: string,
) {
  const messages = (body.messages as OAMessage[]) ?? [];
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join("\n");
  const out: AnMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnBlock[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role)
      last.content.push(...blocks); // Claude wants alternating turns
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: textOf(m.content),
        },
      ]);
    } else if (m.role === "assistant") {
      const blocks = partsToBlocks(m.content);
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {}
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      push("assistant", blocks);
    } else {
      push("user", partsToBlocks(m.content));
    }
  }
  const req: Record<string, unknown> = {
    model,
    messages: out,
    max_tokens: Number(body.max_tokens ?? body.max_completion_tokens ?? 4096),
    ...(system ? { system } : {}),
    ...(body.stream ? { stream: true } : {}),
  };
  const stop = body.stop;
  if (stop)
    req.stop_sequences = (Array.isArray(stop) ? stop : [stop]).filter(
      (s) => typeof s === "string" && s.trim(),
    );
  if (!isClaude5(model)) {
    if (typeof body.temperature === "number")
      req.temperature = Math.min(1, Math.max(0, body.temperature));
    else if (typeof body.top_p === "number") req.top_p = body.top_p;
  }
  const tools = body.tools as
    | {
        type?: string;
        function?: { name: string; description?: string; parameters?: unknown };
      }[]
    | undefined;
  if (Array.isArray(tools) && tools.length) {
    req.tools = tools
      .filter((t) => t.function)
      .map((t) => ({
        name: t.function!.name,
        description: t.function!.description ?? "",
        input_schema: t.function!.parameters ?? {
          type: "object",
          properties: {},
        },
      }));
    const tc = body.tool_choice as
      string | { function?: { name: string } } | undefined;
    if (tc === "required") req.tool_choice = { type: "any" };
    else if (tc === "none") req.tool_choice = { type: "none" };
    else if (tc && typeof tc === "object" && tc.function?.name)
      req.tool_choice = { type: "tool", name: tc.function.name };
  }
  return req;
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  pause_turn: "stop",
  refusal: "content_filter",
};

type AnUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
const promptTokens = (u: AnUsage = {}) =>
  (u.input_tokens ?? 0) +
  (u.cache_creation_input_tokens ?? 0) +
  (u.cache_read_input_tokens ?? 0);

export function fromAnthropicResponse(
  r: { id: string; content?: AnBlock[]; stop_reason?: string; usage?: AnUsage },
  model: string,
) {
  const text = (r.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
  const toolCalls = (r.content ?? [])
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: String(b.id),
      type: "function",
      function: {
        name: String(b.name),
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));
  const prompt = promptTokens(r.usage);
  const completion = r.usage?.output_tokens ?? 0;
  return {
    id: r.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (toolCalls.length ? null : ""),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: FINISH[r.stop_reason ?? ""] ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  };
}

/** Claude SSE → OpenAI chat.completion.chunk SSE (with a final usage chunk). */
function streamToOpenAI(res: Response, model: string): Response {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  let id = "chatcmpl-fuel";
  let prompt = 0;
  let completion = 0;
  const toolIndex = new Map<number, number>(); // Claude block index → OpenAI tool_calls index
  let produced = 0; // pull() must enqueue before returning, or the stream stalls
  const send = (
    c: ReadableStreamDefaultController<Uint8Array>,
    obj: unknown,
  ) => {
    produced++;
    c.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
  };
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(c) {
        const start = produced;
        while (produced === start) {
          const { done, value } = await reader.read();
          if (done) {
            send(c, {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [],
              usage: {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: prompt + completion,
              },
            });
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
            return;
          }
          buf += dec.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";
          for (const e of events) {
            const line = e.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            switch (ev.type) {
              case "message_start": {
                const m = ev.message as { id: string; usage?: AnUsage };
                id = m.id;
                prompt = promptTokens(m.usage);
                completion = m.usage?.output_tokens ?? 0;
                send(c, chunk({ role: "assistant", content: "" }));
                break;
              }
              case "content_block_start": {
                const b = ev.content_block as AnBlock;
                if (b.type === "tool_use") {
                  const ti = toolIndex.size;
                  toolIndex.set(ev.index as number, ti);
                  send(
                    c,
                    chunk({
                      tool_calls: [
                        {
                          index: ti,
                          id: b.id,
                          type: "function",
                          function: { name: b.name, arguments: "" },
                        },
                      ],
                    }),
                  );
                }
                break;
              }
              case "content_block_delta": {
                const d = ev.delta as {
                  type: string;
                  text?: string;
                  partial_json?: string;
                };
                if (d.type === "text_delta" && d.text)
                  send(c, chunk({ content: d.text }));
                if (d.type === "input_json_delta" && d.partial_json)
                  send(
                    c,
                    chunk({
                      tool_calls: [
                        {
                          index: toolIndex.get(ev.index as number) ?? 0,
                          function: { arguments: d.partial_json },
                        },
                      ],
                    }),
                  );
                break;
              }
              case "message_delta": {
                const u = ev.usage as AnUsage | undefined;
                if (u?.output_tokens !== undefined)
                  completion = u.output_tokens;
                const reason = (ev.delta as { stop_reason?: string })
                  ?.stop_reason;
                if (reason) send(c, chunk({}, FINISH[reason] ?? "stop"));
                break;
              }
              case "error":
                send(c, { error: ev.error });
                break;
            }
          }
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

/** Call Claude with an OpenAI-format body; returns an OpenAI-format Response (JSON or SSE). */
export async function callAnthropic(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": VERSION,
    },
    body: JSON.stringify(toAnthropicRequest(body, model)),
    signal,
    cache: "no-store",
  });
  if (!res.ok) return res; // non-2xx: the router counts it as a failed attempt and fails over
  if (body.stream) return streamToOpenAI(res, model);
  return Response.json(fromAnthropicResponse(await res.json(), model));
}
