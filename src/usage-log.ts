/**
 * One structured line per hosted-MCP request, so the usage report can tell real
 * use from probes. The Caddy access log sees only paths and status codes: a
 * liveness bot's `initialize` and a customer's `tools/call` look identical
 * there.
 *
 * Deliberately carries NO personal data and NO secrets: no IP, no token or key
 * material (only which KIND of credential was sent), no tool arguments. The
 * user-agent is kept (truncated) because it is what separates crawlers from
 * clients.
 */

/** `supplier_token`: the supplier endpoint's per-request token (no account). */
export type AuthKind = "none" | "api_key" | "oauth" | "supplier_token";

export interface RpcSummary {
  /** JSON-RPC methods in the body (a batch can carry several). */
  methods: string[];
  /** For tools/call: the tool name and its `action` argument, when present. */
  tools: { name: string; action?: string }[];
  auth: AuthKind;
}

/** A `tp_…` bearer is an API key; any other bearer is an OAuth access token. */
export function authKind(bearerToken: string | null | undefined): AuthKind {
  if (!bearerToken) return "none";
  return bearerToken.startsWith("tp_") ? "api_key" : "oauth";
}

export function summarizeRpc(body: string | undefined, bearerToken: string | null | undefined): RpcSummary {
  const summary: RpcSummary = { methods: [], tools: [], auth: authKind(bearerToken) };
  if (!body) return summary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    summary.methods.push("<unparseable>");
    return summary;
  }
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!m || typeof m !== "object") continue;
    const { method, params } = m as { method?: unknown; params?: unknown };
    if (typeof method !== "string") {
      summary.methods.push("<response>");
      continue;
    }
    summary.methods.push(method);
    if (method === "tools/call" && params && typeof params === "object") {
      const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
      if (typeof name === "string") {
        const action =
          args && typeof args === "object" && typeof (args as { action?: unknown }).action === "string"
            ? ((args as { action: string }).action)
            : undefined;
        summary.tools.push(action ? { name, action } : { name });
      }
    }
  }
  return summary;
}

/** The log line: a fixed prefix the report greps for, then compact JSON. */
export function usageLogLine(args: {
  at: Date;
  endpoint: "mcp" | "supplier";
  httpMethod: string;
  status: number;
  userAgent: string | undefined;
  summary: RpcSummary;
}): string {
  const { at, endpoint, httpMethod, status, userAgent, summary } = args;
  return (
    "mcp_usage " +
    JSON.stringify({
      t: at.toISOString(),
      ep: endpoint,
      http: httpMethod,
      status,
      auth: summary.auth,
      rpc: summary.methods,
      ...(summary.tools.length ? { tools: summary.tools } : {}),
      ua: (userAgent ?? "").slice(0, 80),
    })
  );
}
