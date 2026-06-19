/**
 * HTTP entrypoint — the hosted form of the TracePass MCP server.
 *
 * Runs as a standalone Node service (deployed to Hetzner, served at
 * https://ai.tracepass.eu/mcp). An MCP client connects over
 * Streamable HTTP; the caller's TracePass credential travels in the
 * `Authorization: Bearer <token>` header of every request.
 *
 * BOTH v1 auth methods work here, transparently — we forward the
 * Bearer token to the v1 API unchanged and the platform's unified gate
 * decides: a `tp_…` API key (service account) OR an OAuth 2.0 access
 * token (user-authorized, scoped). The server neither parses nor cares
 * which; it's a pass-through. OAuth-capable MCP clients (Claude.ai,
 * ChatGPT) discover the flow via the 401 `resource_metadata` param and
 * the server card; simpler clients paste a tp_ key.
 *
 * Stateless by design: each MCP request is self-contained, so we
 * build a fresh server + transport per request, bound to that
 * request's token. No server-side session state — which means the
 * service scales horizontally and a restart drops nothing.
 *
 * This is the SAME server core (`createMcpServer`) the stdio
 * entrypoint uses — only the transport + the key source differ.
 *
 * Env:
 *   PORT                (optional) — listen port, default 8080
 *   TRACEPASS_BASE_URL  (optional) — the TracePass API base URL the
 *                       tools call, default https://app.tracepass.eu. In prod
 *                       this is the INTERNAL Docker address (platform:3000).
 *   TRACEPASS_AUTH_SERVER_URL (optional) — the PUBLIC authorization-server
 *                       origin advertised in OAuth discovery metadata, default
 *                       https://app.tracepass.eu. Set this when BASE_URL is an
 *                       internal address so clients get a reachable auth server.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server.js";

const PORT = Number(process.env.PORT) || 8080;
const DEFAULT_BASE_URL = "https://app.tracepass.eu";
// The API base the TOOLS call. In prod this is the INTERNAL Docker address
// (http://platform:3000) — a private loopback, never exposed to clients.
const BASE_URL = process.env.TRACEPASS_BASE_URL?.trim() || DEFAULT_BASE_URL;
// The PUBLIC origin of the TracePass authorization server, used ONLY in the
// OAuth discovery metadata (RFC 9728 `authorization_servers`). MUST be a URL the
// client's browser can reach — distinct from BASE_URL, which in prod is the
// internal loopback. Defaults to the public app origin.
const PUBLIC_AUTH_SERVER_URL =
  process.env.TRACEPASS_AUTH_SERVER_URL?.trim() || DEFAULT_BASE_URL;

/** The MCP endpoint path. `/mcp` is the conventional path. */
const MCP_PATH = "/mcp";

/** The MCP server card discovery path (SEP-1649). */
const SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";

/**
 * RFC 9728 Protected Resource Metadata path. The MCP authorization spec has a
 * client fetch this (pointed to by the `resource_metadata` param on our 401
 * `WWW-Authenticate` challenge) to discover which authorization server protects
 * this resource. TracePass runs a real OAuth2 authorization server at its public
 * origin (PUBLIC_AUTH_SERVER_URL), which we name in the metadata. This is the
 * resource server (ai.tracepass.eu); the authorization server is a different
 * origin — RFC 9728 is exactly the indirection for that split.
 */
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * Glama connector ownership-claim path. Glama probes the CONNECTOR's
 * own host (ai.tracepass.eu) for this file to verify we maintain the
 * auto-imported connector listing at glama.ai/mcp/connectors/eu.tracepass/tracepass.
 * Served here (not just on www) because the connector host is what Glama
 * checks, and the Caddy catch-all redirect for ai.tracepass.eu must
 * EXCLUDE this path too (see tracepass-ops Caddyfile) or it never reaches
 * this handler. The `maintainers` email must match the Glama account login.
 * A byte-equivalent copy also lives at tracepass/public/.well-known/glama.json.
 */
const GLAMA_CLAIM_PATH = "/.well-known/glama.json";
const GLAMA_CLAIM = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  maintainers: [{ email: "malinoto@gmail.com" }],
} as const;

/**
 * Static MCP server card (SEP-1649). Lets an agent discover what this
 * server is and what it offers WITHOUT connecting — served unauthenticated
 * because discovery precedes auth.
 *
 * Every value here mirrors the real server: `serverInfo` matches
 * `MCP_SERVER_INFO` in server.ts (tracepass / 1.4.4); the capability lists are
 * the exact tool names from tools.ts, resource URIs/templates from
 * resources.ts, and prompt names from prompts.ts. Keep this in sync when
 * capabilities change — a card that over-claims is worse than no card.
 *
 * `authentication` declares BOTH supported methods: a static API-key Bearer
 * scheme AND OAuth2 (the platform now runs a real authorization server). The
 * `resourceMetadata` URL points at our RFC 9728 protected-resource document
 * (see the WWW-Authenticate note on the 401 path).
 *
 * MIRROR: a byte-equivalent copy of this card is also served as a static
 * file from the marketing site at
 * `tracepass/public/.well-known/mcp/server-card.json`. The www copy
 * exists because scanners (e.g. isitagentready.com) canonicalize
 * ai.tracepass.eu to its redirect target (www) and only probe there.
 * If you change capabilities/version here, update that file too — they
 * must not drift.
 */
const SERVER_CARD = {
  name: "tracepass",
  version: "1.4.4",
  description:
    "Model Context Protocol server for TracePass — the EU Digital Product Passport platform. Manage products, Digital Product Passports, economic-operator parties, and GS1 EPCIS 2.0 supply-chain events.",
  serverInfo: { name: "tracepass", version: "1.4.4" },
  transport: {
    type: "streamable-http",
    endpoint: `https://ai.tracepass.eu${MCP_PATH}`,
  },
  authentication: {
    // SEP-1649 fields. TracePass now supports BOTH auth methods, so schemes
    // lists both: "bearer" (a static tp_ API key — simplest, server-to-server)
    // and "oauth2" (user-authorized, via the platform's authorization server —
    // discovery at the resource-metadata URL below). A client that can do the
    // OAuth flow gets a "Connect" experience; one that can't falls back to a
    // pasted API key. The type/scheme fields describe the Bearer default for
    // human + non-SEP-1649 readers.
    required: true,
    schemes: ["bearer", "oauth2"],
    type: "http",
    scheme: "bearer",
    // RFC 9728 resource-metadata URL — where an OAuth-capable client learns
    // which authorization server protects this resource.
    resourceMetadata: `https://ai.tracepass.eu${PROTECTED_RESOURCE_METADATA_PATH}`,
    description:
      "Two ways to authenticate, pick one. (1) OAuth 2.0 (recommended for AI assistants acting for a user): if your client supports OAuth, Connect the server and the user approves scopes on a TracePass consent screen — no secret to handle, access is scoped and revocable. Discovery is automatic via this card's resourceMetadata and the 401 WWW-Authenticate challenge (authorization-code + PKCE). (2) API key (simplest for a single user / scripts): the user mints a tp_ key at Developer -> API Keys and you send it as Authorization: Bearer <tp_ key>. The server forwards whichever you send; both reach the same v1 API.",
  },
  capabilities: {
    tools: [
      "tracepass_products",
      "tracepass_passports",
      "tracepass_passport_fields",
      "tracepass_passport_parties",
      "tracepass_epcis",
      "tracepass_templates",
    ],
    resources: ["tracepass://products", "tracepass://templates"],
    resourceTemplates: [
      "tracepass://product/{id}",
      "tracepass://passport/{id}",
      "tracepass://passport/{id}/epcis",
      "tracepass://passport/{id}/compliance",
      "tracepass://template/{category}",
    ],
    prompts: [
      "audit_passport",
      "onboard_product",
      "explain_dpp_requirements",
      "compliance_gap_check",
      "review_epcis_events",
    ],
  },
  documentation: "https://www.tracepass.eu/docs/mcp",
} as const;

/**
 * RFC 9728 Protected Resource Metadata. Declares that this resource
 * (ai.tracepass.eu/mcp) is protected by the TracePass authorization server at
 * its PUBLIC origin (PUBLIC_AUTH_SERVER_URL — NOT the internal BASE_URL the
 * tools call). An OAuth-capable MCP client fetches this after
 * a 401, then drives the authorization-code flow against the named auth server.
 * `scopes_supported` mirrors the platform's OAuth scopes so a client can request
 * least-privilege.
 */
const PROTECTED_RESOURCE_METADATA = {
  resource: `https://ai.tracepass.eu${MCP_PATH}`,
  authorization_servers: [PUBLIC_AUTH_SERVER_URL],
  scopes_supported: [
    "passports:read",
    "passports:write",
    "documents:read",
    "documents:write",
    "suppliers:read",
    "suppliers:write",
    "offline_access",
  ],
  bearer_methods_supported: ["header"],
} as const;

/**
 * Extract the Bearer credential from the Authorization header. This is EITHER a
 * `tp_…` API key OR an OAuth 2.0 access token — we don't distinguish here. The
 * token is forwarded verbatim to the v1 API, whose unified auth gate branches on
 * the token shape (`tp_` prefix → API key, else → OAuth). Both are valid.
 */
function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Read a Node request body into a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Convert a Node IncomingMessage to a Web `Request`, reusing an already-read
 *  body string (the body stream can only be consumed once — we read it up front
 *  to inspect the JSON-RPC method, then hand the buffered copy here). */
function toWebRequest(req: IncomingMessage, body: string | undefined): Request {
  const host = req.headers["host"] ?? `localhost:${PORT}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const method = req.method ?? "GET";
  return new Request(url, { method, headers, body: body || undefined });
}

/**
 * Emit the RFC 6750 Bearer challenge + RFC 9728 resource_metadata as a real HTTP
 * 401. Used for BOTH a missing credential and a present-but-rejected one, so an
 * OAuth-capable client always learns it should (re-)authenticate via the
 * authorization server named in the protected-resource metadata. `reason`
 * tailors the human-readable description.
 * NB: HTTP header values are Latin-1 only — keep this ASCII (use "->" not the
 * UTF-8 arrow, which makes Node throw "Invalid character in header content").
 */
function sendAuthChallenge(res: ServerResponse, reason: "missing" | "invalid"): void {
  const desc =
    reason === "missing"
      ? "Authenticate with a TracePass API key (Developer -> API Keys, send Authorization: Bearer <tp_ key>) or via OAuth (see resource_metadata)."
      : "The credential was rejected (expired or invalid). Refresh your OAuth token or re-authenticate (see resource_metadata), or check your API key.";
  res.setHeader(
    "WWW-Authenticate",
    'Bearer realm="TracePass MCP", error="invalid_token", ' +
      `resource_metadata="https://ai.tracepass.eu${PROTECTED_RESOURCE_METADATA_PATH}", ` +
      `error_description="${desc}"`,
  );
  sendJson(res, 401, {
    error: "unauthorized",
    message:
      reason === "missing"
        ? "Missing credential. Send Authorization: Bearer <tp_ key> (Developer -> API Keys) or connect via OAuth."
        : "The credential was rejected. Refresh your OAuth token or check your API key.",
  });
}

/**
 * JSON-RPC methods that DON'T touch the v1 API — pure MCP protocol / discovery.
 * These are allowed without a credential so catalogs, scanners, and clients can
 * complete the handshake and enumerate capabilities before the user provides a
 * token. Everything else (tools/call, resources/read, prompts/get — the methods
 * whose handlers call the v1 API) requires auth.
 */
const PUBLIC_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "completion/complete",
  "logging/setLevel",
]);

/**
 * Decide whether the request needs a credential. We require auth unless EVERY
 * message in the (possibly batched) body is a public, non-API method. A batch
 * mixing a public method with a tools/call still requires auth (fail closed).
 * A body we can't parse → require auth (fail closed). Empty/GET bodies (the
 * transport's SSE stream open) are treated as public so a token-less client can
 * still establish the stream; the actual tools/call within it is gated.
 */
function requestRequiresAuth(body: string | undefined): boolean {
  if (!body) return false; // GET/SSE open or empty — gate the method calls, not the stream
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true; // unparseable → fail closed
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  // Any message that is NOT a recognised public method → needs auth.
  return msgs.some((m) => {
    if (!m || typeof m !== "object") return true;
    const method = (m as { method?: unknown }).method;
    if (typeof method !== "string") return true; // a response/unknown → fail closed
    return !PUBLIC_METHODS.has(method);
  });
}

/**
 * Probe whether a present credential is actually valid, with a cheap read
 * against the v1 API (the same endpoint the credential test uses). Returns true
 * if the API accepts it, false on a 401/403 (rejected), and — deliberately —
 * true on any other failure (network blip, 5xx) so we DON'T block a connect over
 * a transient error; the real call will surface that later as an isError result.
 */
async function credentialAccepted(bearerToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/products?limit=1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json", "X-Source": "mcp" },
    });
    // Only a hard auth rejection blocks the connect. Everything else passes.
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true; // transient/network — don't block on it
  }
}

/** Write a Web `Response` back through a Node ServerResponse. */
async function writeWebResponse(
  webRes: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => res.setHeader(key, value));
  const text = await webRes.text();
  res.end(text);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const httpServer = createServer((req, res) => {
  void (async () => {
    try {
      const url = req.url ?? "/";

      // Health check — for the Hetzner container's liveness probe.
      if (url === "/health" || url === "/healthz") {
        sendJson(res, 200, { status: "ok", service: "tracepass-mcp" });
        return;
      }

      // MCP server card discovery (SEP-1649). Public + unauthenticated —
      // discovery precedes auth. NB: the edge (Caddy) catch-all redirect
      // for ai.tracepass.eu must EXCLUDE this path, or the card never
      // reaches this handler (see tracepass-ops Caddyfile).
      if (url.split("?")[0] === SERVER_CARD_PATH) {
        sendJson(res, 200, SERVER_CARD);
        return;
      }

      // RFC 9728 Protected Resource Metadata. Public + unauthenticated —
      // an OAuth-capable client fetches this (pointed here by the 401
      // WWW-Authenticate `resource_metadata` param) to discover the
      // authorization server. NB: the edge catch-all redirect must EXCLUDE
      // this path too (same as the card / glama paths).
      if (url.split("?")[0] === PROTECTED_RESOURCE_METADATA_PATH) {
        sendJson(res, 200, PROTECTED_RESOURCE_METADATA);
        return;
      }

      // Glama connector ownership claim. Public + unauthenticated. NB:
      // the edge (Caddy) catch-all redirect for ai.tracepass.eu must
      // EXCLUDE this path, or the claim file never reaches this handler
      // (see tracepass-ops Caddyfile) — same requirement as the card above.
      if (url.split("?")[0] === GLAMA_CLAIM_PATH) {
        sendJson(res, 200, GLAMA_CLAIM);
        return;
      }

      // Only the MCP path is served.
      if (url.split("?")[0] !== MCP_PATH) {
        sendJson(res, 404, {
          error: "not_found",
          message: `This service serves MCP at ${MCP_PATH} only.`,
        });
        return;
      }

      // Read the body once (the stream is single-use); we both inspect it for
      // the JSON-RPC method (to decide auth) and hand the buffered copy to the
      // transport below.
      const method = req.method ?? "GET";
      const bodyStr =
        method !== "GET" && method !== "HEAD" ? await readBody(req) : undefined;

      // Method-aware auth. The MCP HANDSHAKE + DISCOVERY (initialize,
      // tools/list, prompts/list, resources/list, ping, …) are PUBLIC — no
      // credential needed — so catalogs/scanners (mcppedia, Glama) and clients
      // can enumerate capabilities before the user supplies a token. Only the
      // methods whose handlers actually hit the v1 API (tools/call,
      // resources/read, prompts/get) require a credential. See PUBLIC_METHODS.
      const bearerToken = extractBearerToken(req);
      const needsAuth = requestRequiresAuth(bodyStr);

      // A MISSING credential on an auth-required method → real 401 +
      // WWW-Authenticate so a discovery-capable client learns the scheme + the
      // OAuth resource_metadata pointer.
      if (needsAuth && !bearerToken) {
        sendAuthChallenge(res, "missing");
        return;
      }

      // A PRESENT-but-rejected credential on an auth-required method gets a real
      // 401 + challenge — so an OAuth client knows to refresh / re-authenticate
      // rather than only seeing an isError tool result. (Previously probed on
      // `initialize`; initialize is now public, so we validate on the first
      // auth-required method instead.)
      if (needsAuth && bearerToken && !(await credentialAccepted(bearerToken))) {
        sendAuthChallenge(res, "invalid");
        return;
      }

      // Fresh, stateless server + transport per request, bound to this
      // request's credential. The `apiKey` config field carries whatever Bearer
      // token arrived (tp_ key OR OAuth access token) — it's forwarded verbatim;
      // the v1 API's unified gate validates it. For a PUBLIC method (no token
      // required) this is "" — discovery (tools/list etc.) never calls the API,
      // and the api-client renders a readable 401 if a key-less tool call ever
      // slips through.
      const server = createMcpServer({ apiKey: bearerToken ?? "", baseUrl: BASE_URL });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);

      const webReq = toWebRequest(req, bodyStr);
      const webRes = await transport.handleRequest(webReq);
      await writeWebResponse(webRes, res);

      // Stateless — release the per-request server once answered.
      await server.close();
    } catch (err) {
      // Never leak a stack trace; never leave the socket hanging.
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "internal_error",
          message: err instanceof Error ? err.message : "Unexpected error",
        });
      } else {
        res.end();
      }
    }
  })();
});

httpServer.listen(PORT, () => {
  process.stdout.write(
    `tracepass-mcp-server listening on :${PORT}${MCP_PATH} ` +
      `(TracePass API: ${BASE_URL})\n`,
  );
});

// Graceful shutdown so a container stop / redeploy drains cleanly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
  });
}
