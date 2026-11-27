import "server-only";

// Inbound Anthropic Messages format (POST /v1/messages), so tools built on the Claude SDK can use
// Fuel. Requests are translated to OpenAI chat-completions (Fuel's internal format) and replies
// back to Anthropic's format (JSON or SSE). Any Fuel model works, not only Claude.

type Block = {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Block[];
  is_error?: boolean;
};
type AnMsg = { role: "user" | "assistant"; content: string | Block[] };

const blocksText = (c: string | Block[] | undefined) =>
  typeof c === "string"
    ? c
    : (c ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");

/** "claude-sonnet-5-5" → "anthropic/claude-sonnet-5-5"; Fuel ids (with a slash) pass through. */
export const fuelModelId = (m: string) =>
  !m.includes("/") && m.startsWith("claude-") ? `anthropic/${m}` : m;

export function anthropicToOpenAI(body: Record<string, unknown>) {
  const messages: Record<string, unknown>[] = [];
  const system =
    typeof body.system === "string"
      ? body.system
      : blocksText(body.system as Block[] | undefined);
  if (system) messages.push({ role: "system", content: system });
  for (const m of (body.messages as AnMsg[]) ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      messages.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    // user: tool results become tool messages; text and images become content parts
    for (const b of m.content.filter((x) => x.type === "tool_result")) {
      messages.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        content:
          (b.is_error ? "Error: " : "") +
          blocksText(b.content as string | Block[]),
      });
    }
    const parts = m.content
      .filter((b) => b.type === "text" || b.type === "image")
      .map((b) =>
        b.type === "text"
          ? { type: "text", text: b.text ?? "" }
          : {
              type: "image_url",
              image_url: {
                url:
                  b.source?.type === "base64"
                    ? `data:${b.source.media_type};base64,${b.source.data}`
                    : (b.source?.url ?? ""),
              },
            },
      );
    if (parts.length)
      messages.push({
        role: "user",
        content:
          parts.length === 1 && parts[0].type === "text"
            ? (parts[0] as { text: string }).text
            : parts,
      });
  }
  const out: Record<string, unknown> = {
    model: fuelModelId(String(body.model ?? "")),
    messages,
    max_tokens: body.max_tokens,
  };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length)
    out.stop = body.stop_sequences;
  if (body.stream === true) out.stream = true;
  const tools = body.tools as
    | { name: string; description?: string; input_schema?: unknown }[]
    | undefined;
  if (Array.isArray(tools) && tools.length) {
    out.tools = tools
      .filter((t) => t.name)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema ?? { type: "object", properties: {} },
        },
      }));
    const tc = body.tool_choice as { type?: string; name?: string } | undefined;
    if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "none") out.tool_choice = "none";
    else if (tc?.type === "tool" && tc.name)
      out.tool_choice = { type: "function", function: { name: tc.name } };
  }
  return out;
}

const STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
};

type OAResp = {
  id?: string;
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  fuel?: unknown;
};

export function openAIToAnthropic(r: OAResp, model: string) {
  const msg = r.choices?.[0]?.message;
  const content: Record<string, unknown>[] = [];
  if (msg?.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {}
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input,
    });
  }
  return {
    id: r.id ?? "msg_fuel",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP[r.choices?.[0]?.finish_reason ?? ""] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: r.usage?.prompt_tokens ?? 0,
      output_tokens: r.usage?.completion_tokens ?? 0,
    },
    ...(r.fuel ? { fuel: r.fuel } : {}),
  };
}

export function anthropicError(status: number, message: string) {
  const type =
    status === 401
      ? "authentication_error"
      : status === 402
        ? "billing_error"
        : status === 404
          ? "not_found_error"
          : status === 429
            ? "rate_limit_error"
            : status >= 500
              ? "api_error"
              : "invalid_request_error";
  return Response.json({ type: "error", error: { type, message } }, { status });
}

/** OpenAI SSE (from Fuel's job runner) → Anthropic SSE events. */
export function streamOpenAIToAnthropic(
  res: Response,
  model: string,
): Response {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  let started = false;
  let textOpen = false;
  let index = -1;
  let stop = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  const toolBlock = new Map<number, number>(); // OpenAI tool_calls index → Anthropic block index
  let openTool: number | null = null;
  let produced = 0; // pull() must enqueue before returning, or the stream stalls
  const emit = (
    c: ReadableStreamDefaultController<Uint8Array>,
    type: string,
    data: Record<string, unknown>,
  ) => {
    produced++;
    c.enqueue(
      enc.encode(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      ),
    );
  };
  const closeOpen = (c: ReadableStreamDefaultController<Uint8Array>) => {
    if (textOpen || openTool !== null) emit(c, "content_block_stop", { index });
    textOpen = false;
    openTool = null;
  };
  const start = (
    c: ReadableStreamDefaultController<Uint8Array>,
    id: string,
  ) => {
    if (started) return;
    started = true;
    emit(c, "message_start", {
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(c) {
        const before = produced;
        while (produced === before) {
          const { done, value } = await reader.read();
          if (done) {
            start(c, "msg_fuel");
            closeOpen(c);
            emit(c, "message_delta", {
              delta: { stop_reason: stop, stop_sequence: null },
              usage,
            });
            emit(c, "message_stop", {});
            c.close();
            return;
          }
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const d = line.slice(5).trim();
            if (!d || d === "[DONE]") continue;
            let ev: {
              id?: string;
              choices?: {
                delta?: {
                  content?: string;
                  tool_calls?: {
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }[];
                };
                finish_reason?: string | null;
              }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            try {
              ev = JSON.parse(d);
            } catch {
              continue;
            }
            start(c, ev.id ?? "msg_fuel");
            if (ev.usage?.prompt_tokens !== undefined)
              usage = {
                input_tokens: ev.usage.prompt_tokens,
                output_tokens: ev.usage.completion_tokens ?? 0,
              };
            const ch = ev.choices?.[0];
            if (ch?.delta?.content) {
              if (!textOpen) {
                closeOpen(c);
                index++;
                textOpen = true;
                emit(c, "content_block_start", {
                  index,
                  content_block: { type: "text", text: "" },
                });
              }
              emit(c, "content_block_delta", {
                index,
                delta: { type: "text_delta", text: ch.delta.content },
              });
            }
            for (const tc of ch?.delta?.tool_calls ?? []) {
              if (!toolBlock.has(tc.index)) {
                closeOpen(c);
                index++;
                toolBlock.set(tc.index, index);
                openTool = tc.index;
                emit(c, "content_block_start", {
                  index,
                  content_block: {
                    type: "tool_use",
                    id: tc.id ?? `toolu_${index}`,
                    name: tc.function?.name ?? "",
                    input: {},
                  },
                });
              }
              if (tc.function?.arguments)
                emit(c, "content_block_delta", {
                  index: toolBlock.get(tc.index),
                  delta: {
                    type: "input_json_delta",
                    partial_json: tc.function.arguments,
                  },
                });
            }
            if (ch?.finish_reason) stop = STOP[ch.finish_reason] ?? "end_turn";
          }
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    },
  );
}
