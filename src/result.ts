/**
 * Tool-result shaping for the MCP server.
 *
 * Every MCP tool returns a `CallToolResult` — `{ content: [...],
 * isError? }`. This module gives the tools one consistent way to
 * turn a `TracePassApiResponse` into that shape, and — critically —
 * to translate the v1 API's *meaningful* non-2xx responses into
 * results an AI agent can read and act on, rather than opaque
 * errors.
 *
 * The three responses an agent MUST be able to act on:
 *   - 402 overage_required — the write would exceed the plan's DPP
 *     quota; the agent can retry with `confirmOverage: true`.
 *   - 403 plan-gated (e.g. epcis_capture_not_available) — the
 *     feature isn't on the tenant's plan; the agent should tell the
 *     user, not retry.
 *   - 429 rate-limited — the daily write/read budget is spent; retry
 *     tomorrow.
 * Surfacing these as readable `isError: true` text (not a thrown
 * exception) lets the model explain the situation to the user.
 */

/** The MCP CallToolResult shape (text content only — sufficient for
 *  every TracePass tool; no tool returns binary). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** A plain text result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** A successful result carrying JSON data — pretty-printed so the
 *  model reads it cleanly, plus structuredContent for clients that
 *  consume it. */
export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent:
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { result: data },
  };
}

/** An error result — `isError: true` so the client renders it as a
 *  failed tool call, with a human-readable explanation. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Turn a v1 API response into a ToolResult. 2xx → jsonResult. The
 * meaningful non-2xx cases get a specific, actionable explanation;
 * anything else gets a generic error carrying the status + body.
 */
export function apiResult(res: {
  status: number;
  ok: boolean;
  body: unknown;
}): ToolResult {
  if (res.ok) return jsonResult(res.body);

  const body = (res.body ?? {}) as Record<string, unknown>;
  const errorCode = typeof body.error === "string" ? body.error : undefined;
  const message = typeof body.message === "string" ? body.message : undefined;

  switch (res.status) {
    case 401:
      return errorResult(
        "Authentication failed — the TracePass API key is missing or invalid. Check the key configured for this MCP server.",
      );
    case 402:
      // The overage flow. The v1 create-passport routes return this
      // with the plan limit + per-DPP price; the agent can re-call
      // the same tool with confirmOverage: true to accept the charge.
      return errorResult(
        `This action would exceed the plan's included quota. ${message ?? ""}`.trim() +
          " Re-run the tool with confirmOverage: true to accept the per-passport overage charge, or tell the user they've hit their plan limit.",
      );
    case 403:
      return errorResult(
        `Not permitted on this account's plan${errorCode ? ` (${errorCode})` : ""}. ${message ?? "This feature may require a higher plan or a paid add-on."}`.trim() +
          " Do not retry — tell the user this needs a plan change.",
      );
    case 404:
      return errorResult(
        `Not found — ${message ?? "no resource matches that id or serial."}`,
      );
    case 409:
      return errorResult(
        `Conflict — ${message ?? "this would collide with existing data (e.g. a duplicate GTIN or serial)."}`,
      );
    case 422:
      return errorResult(
        `Validation error — ${message ?? "the request payload was rejected. Check the tool arguments against the schema."}`,
      );
    case 429:
      return errorResult(
        "Rate limit reached — the account's daily API budget is spent. It resets at 00:00 UTC; retry then.",
      );
    default:
      return errorResult(
        `TracePass API returned ${res.status}. ${message ?? errorCode ?? JSON.stringify(res.body)}`,
      );
  }
}
