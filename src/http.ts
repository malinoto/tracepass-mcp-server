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
 *                       tools call, default https://app.tracepass.eu
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server.js";

const PORT = Number(process.env.PORT) || 8080;
const DEFAULT_BASE_URL = "https://app.tracepass.eu";
const BASE_URL = process.env.TRACEPASS_BASE_URL?.trim() || DEFAULT_BASE_URL;

/** The MCP endpoint path. `/mcp` is the conventional path. */
const MCP_PATH = "/mcp";

/** The MCP server card discovery path (SEP-1649). */
const SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";

/**
 * RFC 9728 Protected Resource Metadata path. The MCP authorization spec has a
 * client fetch this (pointed to by the `resource_metadata` param on our 401
 * `WWW-Authenticate` challenge) to discover which authorization server protects
 * this resource. TracePass now runs a real OAuth2 authorization server on the
 * platform origin (BASE_URL, app.tracepass.eu), so we name it here. This is the
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
 * `MCP_SERVER_INFO` in server.ts (tracepass / 1.4.0); the capability lists are
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
  version: "1.4.0",
  description:
    "Model Context Protocol server for TracePass — the EU Digital Product Passport platform. Manage products, Digital Product Passports, economic-operator parties, and GS1 EPCIS 2.0 supply-chain events.",
  serverInfo: { name: "tracepass", version: "1.4.0" },
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
 * (ai.tracepass.eu/mcp) is protected by the TracePass authorization server on
 * the platform origin (BASE_URL). An OAuth-capable MCP client fetches this after
 * a 401, then drives the authorization-code flow against the named auth server.
 * `scopes_supported` mirrors the platform's OAuth scopes so a client can request
 * least-privilege.
 */
const PROTECTED_RESOURCE_METADATA = {
  resource: `https://ai.tracepass.eu${MCP_PATH}`,
  authorization_servers: [BASE_URL],
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

/** Convert a Node IncomingMessage to a Web `Request`. */
async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers["host"] ?? `localhost:${PORT}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  return new Request(url, { method, headers, body: body || undefined });
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

      // A credential is required — no anonymous MCP access. Accepts either a
      // tp_ API key or an OAuth access token (forwarded verbatim to the v1 API).
      const bearerToken = extractBearerToken(req);
      if (!bearerToken) {
        // RFC 6750 Bearer challenge + RFC 9728 resource_metadata. MCP clients
        // that do spec-compliant auth discovery read WWW-Authenticate to learn
        // the scheme + (now) where to find the OAuth protected-resource
        // metadata, which names the authorization server they can run the
        // authorization-code flow against. TracePass now supports BOTH a static
        // tp_ API key AND OAuth, so we advertise the resource_metadata param —
        // a Connect-capable client uses OAuth; a simpler client falls back to a
        // pasted key per the human-readable JSON below.
        // NB: HTTP header values are Latin-1 only — no non-ASCII (the
        // "->" stays ASCII; the UTF-8 arrow used in the JSON body below
        // would make Node throw "Invalid character in header content").
        res.setHeader(
          "WWW-Authenticate",
          'Bearer realm="TracePass MCP", error="invalid_token", ' +
            `resource_metadata="https://ai.tracepass.eu${PROTECTED_RESOURCE_METADATA_PATH}", ` +
            'error_description="Authenticate with a TracePass API key (Developer -> API Keys, send Authorization: Bearer <tp_ key>) or via OAuth (see resource_metadata)."',
        );
        sendJson(res, 401, {
          error: "unauthorized",
          message:
            "Missing API key. Send Authorization: Bearer <tp_ key>. Mint a key in the TracePass dashboard → Developer → API Keys.",
        });
        return;
      }

      // Fresh, stateless server + transport per request, bound to this
      // request's credential. The `apiKey` config field carries whatever Bearer
      // token arrived (tp_ key OR OAuth access token) — it's forwarded verbatim;
      // the v1 API's unified gate validates it. The transport's handleRequest
      // takes a Web Request and returns a Web Response.
      const server = createMcpServer({ apiKey: bearerToken, baseUrl: BASE_URL });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);

      const webReq = await toWebRequest(req);
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
