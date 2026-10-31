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
 * Only POST is accepted on MCP endpoints. GET and DELETE would cause the
 * SDK's stateless transport to open an infinite SSE stream; without a
 * session to close it the stream drains indefinitely and leaks memory.
 *
 * Env:
 *   PORT                     (optional) — listen port, default 8080
 *   TRACEPASS_BASE_URL        (optional) — the TracePass API base URL the
 *                             tools call, default https://app.tracepass.eu. In
 *                             prod this is the INTERNAL Docker address
 *                             (platform:3000).
 *   TRACEPASS_AUTH_SERVER_URL (optional) — the PUBLIC authorization-server
 *                             origin advertised in OAuth discovery metadata,
 *                             default https://app.tracepass.eu. Set this when
 *                             BASE_URL is an internal address so clients get a
 *                             reachable auth server.
 *   MCP_BODY_LIMIT_BYTES      (optional) — maximum request body size in bytes,
 *                             default 1 048 576 (1 MB). Requests over the limit
 *                             are rejected with 413 before reaching the SDK.
 *   MCP_BATCH_LIMIT           (optional) — maximum JSON-RPC messages per batch
 *                             request, default 10. Oversized batches are rejected
 *                             with 400 batch_too_large.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { summarizeRpc, usageLogLine, type RpcSummary } from "./usage-log.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, MCP_SERVER_INFO } from "./server.js";
import { createSupplierMcpServer, matchSupplierPath } from "./supplier-server.js";
import { createComplianceMcpServer } from "./compliance-server.js";

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

/** Maximum allowed request body size (bytes). Requests over this limit are
 *  rejected with 413 before the body reaches the SDK or is parsed as JSON. */
const BODY_LIMIT_BYTES = Number(process.env.MCP_BODY_LIMIT_BYTES) || 1_048_576; // 1 MB

/** Maximum number of JSON-RPC messages in a single batch request. A batch
 *  larger than this is rejected with 400 batch_too_large before the SDK sees
 *  it. */
const BATCH_LIMIT = Number(process.env.MCP_BATCH_LIMIT) || 10;

/** The MCP endpoint path. `/mcp` is the conventional path. */
const MCP_PATH = "/mcp";

/** The compliance MCP endpoint path. */
const COMPLIANCE_MCP_PATH = "/compliance/mcp";

/** The MCP server card discovery path (SEP-1649). */
const SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";

/**
 * Compliance server card path. The repo's pattern supports per-path server
 * cards: each path is a conceptually separate server (different tool surface,
 * different auth purpose). The main /mcp card lives at the conventional path;
 * the compliance card lives at the logically parallel per-path variant. The
 * compliance card is not mirrored on the marketing site (the main card is).
 */
const COMPLIANCE_SERVER_CARD_PATH = "/.well-known/mcp/compliance-server-card.json";

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
 * Per-path RFC 9728 metadata for /compliance/mcp. The `resource` is exactly
 * `https://ai.tracepass.eu/compliance/mcp` so an OAuth client that connects to
 * that path can discover the correct auth server through its own challenge. The
 * per-path path (`/compliance/mcp` appended) is the conventional RFC 9728 layout
 * for multi-resource servers.
 */
const COMPLIANCE_PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/compliance/mcp";

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
 * Every value here mirrors the real server: `serverInfo` reuses
 * `MCP_SERVER_INFO` from server.ts rather than re-typing the version, so a
 * release can't leave the card reporting a stale one; the capability lists are
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
 *
 * GENERATED: the www copy is written from THIS object by
 * `scripts/build-server-card.mjs` (hence the export) — don't hand-edit it.
 * `npm run build:server-card` writes it; `--check` verifies it.
 */
export const SERVER_CARD = {
  name: MCP_SERVER_INFO.name,
  version: MCP_SERVER_INFO.version,
  description:
    "Model Context Protocol server for TracePass — the EU Digital Product Passport platform. Manage products, Digital Product Passports, economic-operator parties, and GS1 EPCIS 2.0 supply-chain events.",
  serverInfo: { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
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
      "tracepass_scope",
    ],
    resources: ["tracepass://products", "tracepass://templates"],
    resourceTemplates: [
      "tracepass://product/{id}",
      "tracepass://passport/{id}",
      "tracepass://passport/{id}/epcis",
      "tracepass://passport/{id}/compliance",
      "tracepass://passport/{id}/registry-readiness",
      "tracepass://passport/{id}/snapshots",
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
 * RFC 9728 Protected Resource Metadata for the compliance endpoint.
 * `resource` is EXACTLY `https://ai.tracepass.eu/compliance/mcp` — the MCP
 * authorization spec requires the resource URL to match the endpoint URL
 * precisely. The compliance server uses a narrower scope set (regulatory:read
 * and passports:write for the draft-creation tool) compared to the full /mcp
 * server. Clients requesting access for the compliance assistant should request
 * these scopes, not the full /mcp scope set.
 */
const COMPLIANCE_PROTECTED_RESOURCE_METADATA = {
  resource: `https://ai.tracepass.eu${COMPLIANCE_MCP_PATH}`,
  authorization_servers: [PUBLIC_AUTH_SERVER_URL],
  scopes_supported: [
    "regulatory:read",
    "passports:read",
    "passports:write",
    "offline_access",
  ],
  bearer_methods_supported: ["header"],
} as const;

/**
 * Compliance server card (SEP-1649) for /compliance/mcp.
 *
 * Per-path server cards: the repo pattern supports one card per path; each MCP
 * path is a conceptually separate server. The main card at SERVER_CARD_PATH is
 * mirrored on the marketing site and exported; the compliance card is internal
 * to this service (not mirrored — the compliance endpoint is in-house only and
 * is not listed in the public npm server registry). Keep capabilities.tools in
 * sync with buildComplianceTools() in compliance-server.ts; tests enforce this.
 */
export const COMPLIANCE_SERVER_CARD = {
  name: "tracepass-compliance",
  version: MCP_SERVER_INFO.version,
  description:
    "DPP Compliance Assistant for TracePass — answers EU Digital Product Passport scope, field, registry and change questions for your product categories. In-house endpoint; not published to npm.",
  serverInfo: { name: "tracepass-compliance", version: MCP_SERVER_INFO.version },
  transport: {
    type: "streamable-http",
    endpoint: `https://ai.tracepass.eu${COMPLIANCE_MCP_PATH}`,
  },
  authentication: {
    required: true,
    schemes: ["bearer", "oauth2"],
    type: "http",
    scheme: "bearer",
    resourceMetadata: `https://ai.tracepass.eu${COMPLIANCE_PROTECTED_RESOURCE_METADATA_PATH}`,
    description:
      "Same two options as /mcp. (1) OAuth 2.0: Connect the server and the user approves scopes on a TracePass consent screen — scopes regulatory:read, passports:read, passports:write. (2) API key: send a tp_ key as Authorization: Bearer <tp_ key>.",
  },
  capabilities: {
    tools: [
      "scope_check",
      "required_fields",
      "what_changed",
      "registry_guidance",
      "create_draft_passport",
      "report_answer",
      "get_profile",
      "update_profile",
      "delete_profile",
    ],
  },
  documentation: "https://www.tracepass.eu/docs/mcp",
} as const;

/**
 * Thrown by readBody when the incoming request body exceeds BODY_LIMIT_BYTES.
 * Caught in handleRequestAsync to send a 413 response and log nothing (the
 * caller is responsible for the oversized data, not us).
 */
class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the size limit");
  }
}

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

/**
 * Read the request body into a string, capping at BODY_LIMIT_BYTES.
 * When the limit is exceeded we stop accumulating but keep draining (reading
 * and discarding) so Node can flush the socket and the 413 response can be
 * written. Calling req.destroy() immediately would close the socket before
 * the response headers reach the client. BodyTooLargeError is thrown from the
 * "end" handler, after all data has been consumed. The `requestTimeout` on the
 * HTTP server caps how long we drain.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    req.on("data", (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (tooLarge) return; // already over limit — drain but discard
      if (size > BODY_LIMIT_BYTES) {
        tooLarge = true;
        return; // stop accumulating; drain the rest in subsequent "data" events
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        reject(new BodyTooLargeError());
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
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
 * Same as sendAuthChallenge but for /compliance/mcp: the resource_metadata URL
 * points to the per-path metadata document so an OAuth client discovers the
 * correct resource descriptor for this path.
 */
function sendComplianceAuthChallenge(res: ServerResponse, reason: "missing" | "invalid"): void {
  const desc =
    reason === "missing"
      ? "Authenticate with a TracePass API key or via OAuth for the DPP Compliance Assistant (see resource_metadata)."
      : "The credential was rejected. Refresh your OAuth token or re-authenticate (see resource_metadata), or check your API key.";
  res.setHeader(
    "WWW-Authenticate",
    'Bearer realm="TracePass DPP Compliance Assistant", error="invalid_token", ' +
      `resource_metadata="https://ai.tracepass.eu${COMPLIANCE_PROTECTED_RESOURCE_METADATA_PATH}", ` +
      `error_description="${desc}"`,
  );
  sendJson(res, 401, {
    error: "unauthorized",
    message:
      reason === "missing"
        ? "Missing credential. Send Authorization: Bearer <tp_ key> or connect via OAuth for the DPP Compliance Assistant."
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
  if (!body) return false; // empty body — gate the method calls, not the stream
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
 * against the v1 API (the same endpoint the credential test uses). Returns false
 * only on a 401, which is how v1 auth answers every bad, expired or revoked
 * credential. A 403 is about the account, not the credential (subscription not
 * active, API access off, a missing OAuth scope): answering it with an
 * invalid_token challenge made clients ask the user to re-authorise, which can
 * never fix it, so the call goes through and the tool result says what is wrong.
 * Any other failure (network blip, 5xx) also passes, so a transient error does
 * not block a connect; the real call surfaces it as an isError result.
 */
export async function credentialAccepted(bearerToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/products?limit=1`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json", "X-Source": "mcp" },
    });
    return res.status !== 401;
  } catch {
    return true; // transient/network — don't block on it
  }
}

/**
 * Write a Web `Response` back through a Node ServerResponse, streaming the
 * body chunk-by-chunk. Streaming avoids buffering a potentially large or
 * infinite response body (e.g. an SSE stream) in memory, and sends the HTTP
 * status line as soon as the first chunk arrives. Cancels the body reader if
 * the client disconnects mid-response.
 */
async function writeWebResponse(
  webRes: Response,
  res: ServerResponse,
  req: IncomingMessage,
): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => res.setHeader(key, value));

  if (!webRes.body) {
    res.end();
    return;
  }

  const reader = webRes.body.getReader();
  const onClose = (): void => { void reader.cancel().catch(() => {}); };
  req.once("close", onClose);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Respect backpressure: wait for drain before reading the next chunk.
      if (!res.write(value)) {
        await new Promise<void>((r, j) => {
          res.once("drain", r);
          res.once("error", j);
        });
      }
    }
    res.end();
  } catch {
    // Client disconnected or write error — destroy the socket cleanly.
    res.destroy();
  } finally {
    req.removeListener("close", onClose);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Exported request handler so tests can mount it on a port-0 server without
 * triggering the module-level listen() call. Production entry point is the
 * httpServer.listen() call below, guarded by the VITEST env check.
 */
export function requestHandler(req: IncomingMessage, res: ServerResponse): void {
  void handleRequestAsync(req, res);
}

async function handleRequestAsync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

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

    // The supplier endpoint. Deliberately NO auth gate and NO
    // WWW-Authenticate challenge here: a supplier has no account, so an
    // OAuth prompt would be a dead end for someone with no TracePass account.
    // An invalid or missing token reaches the tools, which explain it in plain
    // words (supplier-server.ts).
    const supplier = matchSupplierPath(url.split("?")[0]!);
    if (supplier) {
      // Only POST: stateless — no SSE session to resume; GET or DELETE would
      // open an infinite SSE stream that writeWebResponse streams indefinitely.
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { error: "method_not_allowed", message: "This endpoint accepts POST only." });
        return;
      }
      const sBodyStr = await readBody(req);
      // Batch cap: reject oversized batches before the SDK processes them.
      try {
        const sParsed = JSON.parse(sBodyStr) as unknown;
        if (Array.isArray(sParsed) && sParsed.length > BATCH_LIMIT) {
          sendJson(res, 400, {
            error: "batch_too_large",
            message: `JSON-RPC batch exceeds the limit of ${BATCH_LIMIT} requests per call.`,
          });
          return;
        }
      } catch { /* unparseable — let the transport produce the JSON-RPC error */ }
      const token = supplier.pathToken || extractBearerToken(req) || "";
      logUsageOnFinish(req, res, "supplier", {
        ...summarizeRpc(sBodyStr, null),
        auth: token ? "supplier_token" : "none",
      });
      const sServer = createSupplierMcpServer({ token, baseUrl: BASE_URL, publicBaseUrl: PUBLIC_AUTH_SERVER_URL });
      const sTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await sServer.connect(sTransport);
      // Release the per-request server if the client disconnects before the response completes.
      req.once("close", () => { void sServer.close().catch(() => {}); });
      const sWebRes = await sTransport.handleRequest(toWebRequest(req, sBodyStr));
      await writeWebResponse(sWebRes, res, req);
      await sServer.close().catch(() => {});
      return;
    }

    // Compliance server card. Public + unauthenticated — discovery precedes auth.
    // Per-path server cards: the main /mcp card is at SERVER_CARD_PATH; the
    // compliance card is at COMPLIANCE_SERVER_CARD_PATH. Not mirrored on the
    // marketing site (compliance endpoint is in-house only).
    if (url.split("?")[0] === COMPLIANCE_SERVER_CARD_PATH) {
      sendJson(res, 200, COMPLIANCE_SERVER_CARD);
      return;
    }

    // RFC 9728 Protected Resource Metadata for /compliance/mcp. Public +
    // unauthenticated. The `resource` is exactly `https://ai.tracepass.eu/compliance/mcp`.
    if (url.split("?")[0] === COMPLIANCE_PROTECTED_RESOURCE_METADATA_PATH) {
      sendJson(res, 200, COMPLIANCE_PROTECTED_RESOURCE_METADATA);
      return;
    }

    // Compliance MCP path. Auth-gated (OAuth or API key), like /mcp, but the
    // WWW-Authenticate challenge points to the per-path resource metadata so a
    // client connecting to /compliance/mcp discovers the correct OAuth resource.
    if (url.split("?")[0] === COMPLIANCE_MCP_PATH) {
      // Only POST: same reason as the supplier and main /mcp paths.
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { error: "method_not_allowed", message: "This endpoint accepts POST only." });
        return;
      }
      const cBodyStr = await readBody(req);
      try {
        const cParsed = JSON.parse(cBodyStr) as unknown;
        if (Array.isArray(cParsed) && cParsed.length > BATCH_LIMIT) {
          sendJson(res, 400, {
            error: "batch_too_large",
            message: `JSON-RPC batch exceeds the limit of ${BATCH_LIMIT} requests per call.`,
          });
          return;
        }
      } catch { /* unparseable */ }
      const cBearerToken = extractBearerToken(req);
      const cNeedsAuth = requestRequiresAuth(cBodyStr);
      logUsageOnFinish(req, res, "compliance", summarizeRpc(cBodyStr, cBearerToken));

      if (cNeedsAuth && !cBearerToken) {
        sendComplianceAuthChallenge(res, "missing");
        return;
      }
      if (cNeedsAuth && cBearerToken && !(await credentialAccepted(cBearerToken))) {
        sendComplianceAuthChallenge(res, "invalid");
        return;
      }

      const cServer = createComplianceMcpServer({ apiKey: cBearerToken ?? "", baseUrl: BASE_URL });
      const cTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await cServer.connect(cTransport);
      req.once("close", () => { void cServer.close().catch(() => {}); });
      const cWebRes = await cTransport.handleRequest(toWebRequest(req, cBodyStr));
      await writeWebResponse(cWebRes, res, req);
      await cServer.close().catch(() => {});
      return;
    }

    // Only the main MCP path remains.
    if (url.split("?")[0] !== MCP_PATH) {
      sendJson(res, 404, {
        error: "not_found",
        message: `This service serves MCP at ${MCP_PATH} and ${COMPLIANCE_MCP_PATH}.`,
      });
      return;
    }

    // Only POST: stateless — no SSE session to resume; GET or DELETE would
    // open an infinite SSE stream that writeWebResponse streams indefinitely.
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "method_not_allowed", message: "This endpoint accepts POST only." });
      return;
    }

    // Read the body once (the stream is single-use); we both inspect it for
    // the JSON-RPC method (to decide auth) and hand the buffered copy to the
    // transport below.
    const bodyStr = await readBody(req);

    // Batch cap: reject oversized batches before the SDK processes them.
    try {
      const parsed = JSON.parse(bodyStr) as unknown;
      if (Array.isArray(parsed) && parsed.length > BATCH_LIMIT) {
        sendJson(res, 400, {
          error: "batch_too_large",
          message: `JSON-RPC batch exceeds the limit of ${BATCH_LIMIT} requests per call.`,
        });
        return;
      }
    } catch { /* unparseable — let the transport produce the JSON-RPC error */ }

    // Method-aware auth. The MCP HANDSHAKE + DISCOVERY (initialize,
    // tools/list, prompts/list, resources/list, ping, …) are PUBLIC — no
    // credential needed — so catalogs/scanners (mcppedia, Glama) and clients
    // can enumerate capabilities before the user supplies a token. Only the
    // methods whose handlers actually hit the v1 API (tools/call,
    // resources/read, prompts/get) require a credential. See PUBLIC_METHODS.
    const bearerToken = extractBearerToken(req);
    const needsAuth = requestRequiresAuth(bodyStr);
    logUsageOnFinish(req, res, "mcp", summarizeRpc(bodyStr, bearerToken));

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

    // Release the per-request server if the client disconnects before the
    // response completes.
    req.once("close", () => { void server.close().catch(() => {}); });

    const webReq = toWebRequest(req, bodyStr);
    const webRes = await transport.handleRequest(webReq);
    await writeWebResponse(webRes, res, req);

    // Stateless — release the per-request server once answered.
    await server.close().catch(() => {});

  } catch (err) {
    // Body too large: client sent more than BODY_LIMIT_BYTES. Send 413 and
    // don't log (the client is responsible for the oversized payload).
    if (err instanceof BodyTooLargeError) {
      if (!res.headersSent) {
        sendJson(res, 413, { error: "request_too_large", message: "Request body exceeds the maximum allowed size." });
      } else {
        res.destroy();
      }
      return;
    }
    // Unexpected error: log with a random reference id and return a generic
    // message so internal details (paths, internal URLs, stack traces) never
    // leave the server.
    const eid = Math.random().toString(36).slice(2, 10);
    process.stderr.write(
      `[mcp:${eid}] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: "internal_error",
        message: `An unexpected error occurred (ref: ${eid}).`,
      });
    } else {
      res.end();
    }
  }
}

/**
 * Write one `mcp_usage` line when the response finishes, whatever path answered
 * it (tool result, 401 challenge, error). Read by the local usage report; see
 * usage-log.ts for what it deliberately leaves out.
 */
function logUsageOnFinish(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: "mcp" | "supplier" | "compliance",
  summary: RpcSummary,
): void {
  res.once("finish", () => {
    process.stdout.write(
      usageLogLine({
        at: new Date(),
        endpoint,
        httpMethod: req.method ?? "GET",
        status: res.statusCode,
        userAgent: req.headers["user-agent"],
        summary,
      }) + "\n",
    );
  });
}

const httpServer = createServer(
  // headersTimeout: abort connections that are slow to deliver request headers
  // (slow-loris header attacks). requestTimeout: abort connections that are slow
  // to deliver the request body. Both in milliseconds.
  { headersTimeout: 10_000, requestTimeout: 30_000 },
  requestHandler,
);

// Skip starting the listener when imported by the Vitest test runner — prevents
// EADDRINUSE conflicts when multiple test workers import this module.
if (!process.env.VITEST) {
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
}
