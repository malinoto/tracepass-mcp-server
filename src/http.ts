/**
 * HTTP entrypoint — the hosted form of the TracePass MCP server.
 *
 * Runs as a standalone Node service (deployed to Hetzner, served at
 * https://ai.tracepass.eu/mcp). An MCP client connects over
 * Streamable HTTP; the customer's TracePass API key travels in the
 * `Authorization: Bearer tp_...` header of every request.
 *
 * Stateless by design: each MCP request is self-contained, so we
 * build a fresh server + transport per request, bound to that
 * request's API key. No server-side session state — which means the
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
 * Static MCP server card (SEP-1649). Lets an agent discover what this
 * server is and what it offers WITHOUT connecting — served unauthenticated
 * because discovery precedes auth.
 *
 * Every value here mirrors the real server: `serverInfo` matches
 * `SERVER_INFO` in server.ts (tracepass / 1.1.1); the capability lists are
 * the exact tool names from tools.ts, resource URIs/templates from
 * resources.ts, and prompt names from prompts.ts. Keep this in sync when
 * capabilities change — a card that over-claims is worse than no card.
 *
 * `authentication` is declared honestly: a static API-key Bearer scheme,
 * NOT OAuth. No `authorization_servers` / OAuth metadata is advertised
 * because none exists (see the WWW-Authenticate note on the 401 path).
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
  version: "1.1.1",
  description:
    "Model Context Protocol server for TracePass — the EU Digital Product Passport platform. Manage products, Digital Product Passports, economic-operator parties, and GS1 EPCIS 2.0 supply-chain events.",
  serverInfo: { name: "tracepass", version: "1.1.1" },
  transport: {
    type: "streamable-http",
    endpoint: `https://ai.tracepass.eu${MCP_PATH}`,
  },
  authentication: {
    type: "http",
    scheme: "bearer",
    description:
      "TracePass API key (tp_ prefix). Mint one in the dashboard under Developer -> API Keys, then send Authorization: Bearer <tp_ key>.",
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

/** Extract the tp_ API key from the Authorization header. */
function extractApiKey(req: IncomingMessage): string | null {
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

      // Only the MCP path is served.
      if (url.split("?")[0] !== MCP_PATH) {
        sendJson(res, 404, {
          error: "not_found",
          message: `This service serves MCP at ${MCP_PATH} only.`,
        });
        return;
      }

      // API key required — no anonymous MCP access.
      const apiKey = extractApiKey(req);
      if (!apiKey) {
        // RFC 6750 Bearer challenge. MCP clients that do spec-compliant
        // auth discovery read WWW-Authenticate to learn the scheme;
        // without it they can only fall back to the human-readable JSON
        // below. TracePass auth is static dashboard-minted API keys, NOT
        // OAuth — so this is the honest subset: advertise the Bearer
        // scheme + realm + where to get a key, and deliberately DO NOT
        // emit an OAuth `resource_metadata` / `authorization_uri` param
        // pointing at /.well-known/oauth-protected-resource, because no
        // OAuth authorization server exists. (Adding one would be a
        // false discovery claim — same reason www skips the auth.md
        // check.) If TracePass ever ships real OAuth client registration,
        // add the resource_metadata param then.
        // NB: HTTP header values are Latin-1 only — no non-ASCII (the
        // "->" stays ASCII; the UTF-8 arrow used in the JSON body below
        // would make Node throw "Invalid character in header content").
        res.setHeader(
          "WWW-Authenticate",
          'Bearer realm="TracePass MCP", error="invalid_token", ' +
            'error_description="Missing API key. Mint one in the TracePass dashboard (Developer -> API Keys), then send Authorization: Bearer <tp_ key>."',
        );
        sendJson(res, 401, {
          error: "unauthorized",
          message:
            "Missing API key. Send Authorization: Bearer <tp_ key>. Mint a key in the TracePass dashboard → Developer → API Keys.",
        });
        return;
      }

      // Fresh, stateless server + transport per request, bound to
      // this request's key. The transport's handleRequest takes a
      // Web Request and returns a Web Response.
      const server = createMcpServer({ apiKey, baseUrl: BASE_URL });
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
