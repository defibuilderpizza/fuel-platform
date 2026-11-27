// OpenAI-shaped errors so existing agent SDKs surface them properly.

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "insufficient_balance"
  | "spending_limit"
  | "not_found"
  | "provider_error"
  | "server_error"
  | "not_configured"
  | "permission_error"
  | "rate_limit_error";

export function apiError(status: number, type: ErrorType, message: string, code?: string) {
  return Response.json({ error: { message, type, code: code ?? type } }, { status });
}

/** 429 with Retry-After, OpenAI-shaped so SDKs back off and retry. */
export function rateLimited(message: string, retryAfter: number) {
  return Response.json(
    { error: { message, type: "rate_limit_error", code: "rate_limit_exceeded" } },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
