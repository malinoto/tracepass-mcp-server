/**
 * HTTP client for the TracePass v1 API, used by the MCP tools.
 *
 * Design decision — why the MCP tools talk to the v1 API over HTTP
 * rather than calling `lib/` functions in-process:
 *   - The v1 route handlers already encapsulate API-key auth,
 *     idempotency, the overage (402) flow, plan-gating, and the
 *     per-day write/read counter bumps. Re-implementing that inside
 *     the MCP tools would inevitably drift from the routes.
 *   - It is the SAME code path the standalone npm package will use,
 *     so the MCP core is genuinely transport-agnostic — the hosted
 *     /mcp endpoint and the local npm package differ only in base
 *     URL and where the key comes from.
 *   - One bug surface, not two.
 * The cost is a loopback HTTP hop when hosted — negligible.
 *
 * The client is intentionally thin: it forwards the Bearer key,
 * sets Idempotency-Key on writes, and returns the parsed JSON plus
 * the status code. Interpreting a 402 overage / 403 plan-gate /
 * 429 rate-limit is the tool's job — those are meaningful results an
 * AI agent must see and act on, not errors to swallow.
 */

/** Value sent in the `X-Source` header on every request, so the TracePass
 *  request log can attribute v1 traffic to this client (vs n8n / raw api). */
export const SOURCE_TAG = "mcp";

export interface TracePassApiResponse {
  /** HTTP status code. */
  status: number;
  /** `true` for 2xx. */
  ok: boolean;
  /** Parsed JSON body, or null when the body was empty / not JSON. */
  body: unknown;
}

export interface TracePassClientConfig {
  /** Base URL of the TracePass app, no trailing slash —
   *  e.g. "https://app.tracepass.eu". */
  baseUrl: string;
  /** The caller's tp_ API key. */
  apiKey: string;
}

/** Generate a random Idempotency-Key for a write request. */
function newIdempotencyKey(): string {
  // crypto.randomUUID is available on Node 18+ and every Web runtime
  // the MCP server can plausibly run on.
  return `mcp-${crypto.randomUUID()}`;
}

export class TracePassClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: TracePassClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  /**
   * Perform a v1 API request.
   *
   * @param method  HTTP method
   * @param path    path under the base URL, must start with "/"
   * @param body    JSON body for write methods (omitted for GET)
   *
   * Write methods automatically carry an `Idempotency-Key` header so
   * a retried tool call doesn't double-execute. Never throws on a
   * non-2xx response — the status + body come back for the tool to
   * interpret. Throws only on a genuine network/transport failure.
   */
  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<TracePassApiResponse> {
    // The key is required to make any v1 call, but NOT to start the
    // server or list its tools — so introspecting clients (Glama,
    // Smithery, MCP inspectors) can enumerate capabilities key-less.
    // The check lives here, at call time, returning a 401-shaped
    // response the tool handlers already render as a readable error.
    if (!this.apiKey || this.apiKey.trim() === "") {
      return {
        status: 401,
        ok: false,
        body: {
          error:
            "TRACEPASS_API_KEY is not set. Add a tp_ key (TracePass dashboard → Developer → API Keys) to the MCP server's env config before calling tools.",
        },
      };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      // Identify this client to the TracePass request log so traffic can be
      // attributed to the MCP server vs the n8n node vs raw API integrations.
      "X-Source": SOURCE_TAG,
    };
    const init: RequestInit = { method, headers };

    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = newIdempotencyKey();
      init.body = JSON.stringify(body);
    }

    const res = await fetch(`${this.baseUrl}${path}`, init);

    let parsed: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON body (e.g. an HTML error page from a proxy) —
        // keep the raw text so the tool can still report something.
        parsed = { raw: text };
      }
    }

    return { status: res.status, ok: res.ok, body: parsed };
  }

  get(path: string) {
    return this.request("GET", path);
  }
  post(path: string, body?: unknown) {
    return this.request("POST", path, body ?? {});
  }
  patch(path: string, body?: unknown) {
    return this.request("PATCH", path, body ?? {});
  }
  delete(path: string) {
    return this.request("DELETE", path);
  }
}
