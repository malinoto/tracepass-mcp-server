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
 *   - 402 payment required — the subscription is past due, or a
 *     metered write (EPCIS capture, measurements) would exceed the
 *     plan's allowance; the agent should tell the user, not retry.
 *   - 403 plan-gated (e.g. epcis_capture_not_available) — the
 *     feature isn't on the tenant's plan; the agent should tell the
 *     user, not retry.
 *   - 429 rate-limited — the daily write/read budget is spent; retry
 *     tomorrow.
 * Surfacing these as readable `isError: true` text (not a thrown
 * exception) lets the model explain the situation to the user.
 */

/**
 * The MCP CallToolResult shape (text content only — sufficient for
 *  every TracePass tool; no tool returns binary).
 */
export interface ToolResult {
  // Index signature: structurally matches the SDK's `CallToolResult` without a cast.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * Plain text for a value of unknown type that may be a string or a number, as the
 * platform's JSON gives identifiers and counts. Anything else has no sensible text.
 * @param value a value read from a platform response body
 * @returns the text, or undefined when the value is neither a string nor a number
 */
export function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * A plain text result.
 * @param text the text to return
 * @returns a tool result with one text block
 */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * A successful result carrying JSON data — pretty-printed so the
 *  model reads it cleanly, plus structuredContent for clients that
 *  consume it.
 * @param data the value to return
 * @returns a tool result with the data as text and structured content
 */
export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent:
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { result: data },
  };
}

/**
 * An error result — `isError: true` so the client renders it as a
 *  failed tool call, with a human-readable explanation.
 * @param message the explanation shown to the model
 * @returns a tool result flagged as an error
 */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Turn a v1 API response into a ToolResult. 2xx → jsonResult. The
 * meaningful non-2xx cases get a specific, actionable explanation;
 * anything else gets a generic error carrying the status + body.
 */
/**
 * The text for a 403 that is about the account's state rather than its plan
 * tier, or null. v1 auth answers every call with 403 "Subscription is not
 * active" while the subscription is past due, unpaid or cancelled, and with
 * "API access is disabled for this account." when access was switched off.
 * Neither is fixed by a plan change or by re-authorising, so say what is.
 * @param errorCode the `error` text of a 403 response body
 * @returns the explanation, or null when the error is not about the account state
 */
export function inactiveAccountMessage(errorCode: string | undefined): string | null {
  if (errorCode && /subscription is not active/i.test(errorCode)) {
    return (
      "The TracePass account's subscription is not active (for example a failed payment or a cancelled plan), so TracePass refuses every request until billing is resolved." +
      " Do not retry, and do not ask the user to re-authorise: tell them to resolve billing in TracePass (Billing page)."
    );
  }
  if (errorCode && /api access is disabled/i.test(errorCode)) {
    return "API access is switched off for this TracePass account. Do not retry: tell the user to contact TracePass support.";
  }
  return null;
}

/**
 * Turn a v1 API response into a tool result: data for a 2xx, readable text for the meaningful 4xx cases.
 * @param res the platform response to render
 * @param res.status HTTP status code of the platform response
 * @param res.ok true for a 2xx status
 * @param res.body parsed response body, or null when empty
 * @returns the tool result for the response
 */
export function apiResult(res: { status: number; ok: boolean; body: unknown }): ToolResult {
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
      // Payment required: a past-due subscription (every write), or a
      // metered write over the plan's allowance (EPCIS capture,
      // measurements). No tool here accepts an overage charge, so the
      // agent explains it rather than retrying. Creating a passport
      // never returns an overage 402: a draft takes no plan slot.
      return errorResult(
        `Payment required${errorCode ? ` (${errorCode})` : ""}. ${message ?? "The account's subscription or plan allowance blocks this write."}`.trim() +
          " Do not retry — tell the user to resolve billing or raise the plan's allowance in TracePass.",
      );
    case 403:
      return errorResult(
        inactiveAccountMessage(errorCode) ??
          `Not permitted on this account's plan${errorCode ? ` (${errorCode})` : ""}. ${message ?? "This feature may require a higher plan or a paid add-on."}`.trim() +
            " Do not retry — tell the user this needs a plan change.",
      );
    case 404:
      return errorResult(`Not found — ${message ?? "no resource matches that id or serial."}`);
    case 409: {
      // Refusal codes (e.g. place-on-market's registry_not_ready) often carry no
      // `message`; the code and any `findings[]` are what the agent must act on.
      const findings = Array.isArray(body.findings)
        ? body.findings.filter((f): f is string => typeof f === "string")
        : [];
      const detail =
        message ??
        (errorCode
          ? undefined
          : "this would collide with existing data (e.g. a duplicate GTIN or serial).");
      return errorResult(
        [
          `Conflict${errorCode ? ` (${errorCode})` : ""}${detail ? ` — ${detail}` : "."}`,
          ...(findings.length > 0 ? ["Findings:", ...findings.map((f) => `- ${f}`)] : []),
        ].join("\n"),
      );
    }
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
        `TracePass API returned ${String(res.status)}. ${message ?? errorCode ?? JSON.stringify(res.body)}`,
      );
  }
}
