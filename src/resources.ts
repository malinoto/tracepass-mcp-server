/**
 * MCP resources for the TracePass server.
 *
 * Resources differ from tools: a tool is something the model
 * *calls*; a resource is data the user (or client) *attaches as
 * context*. For TracePass that's read-only entity data — a product,
 * a passport, its EPCIS event history — addressed by a `tracepass://`
 * URI so a user can drop "this passport" into a conversation.
 *
 * Two kinds, both registered here:
 *   - a STATIC resource — `tracepass://products` — the catalogue;
 *   - RESOURCE TEMPLATES — `tracepass://passport/{id}` etc. —
 *     parameterised URIs the client can complete.
 *
 * All resource reads are read-only and go through the same v1 API
 * client as the tools, so auth / plan-gating / rate-limits behave
 * identically.
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TracePassClient } from "./api-client.js";

/** Build a ReadResourceResult `contents` entry carrying JSON text. */
function jsonContents(uri: string, data: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/** Build a contents entry for an error — resources can't return an
 *  isError flag, so an unreadable resource yields a JSON error body
 *  the model can still read. */
function errorContents(uri: string, status: number, body: unknown) {
  return jsonContents(uri, {
    error: `TracePass API returned ${status}`,
    detail: body,
  });
}

/**
 * Register every TracePass resource + resource template on the
 * server, bound to a v1 API client.
 */
export function registerResources(
  server: McpServer,
  client: TracePassClient,
): void {
  // ── Static resource: the product catalogue ────────────────────
  server.registerResource(
    "products",
    "tracepass://products",
    {
      title: "Product catalogue",
      description:
        "The account's TracePass product catalogue (first page). Attach this for an overview of what products exist.",
      mimeType: "application/json",
    },
    async (uri) => {
      const res = await client.get("/api/v1/products?limit=100");
      return res.ok
        ? jsonContents(uri.href, res.body)
        : errorContents(uri.href, res.status, res.body);
    },
  );

  // ── Template: a product by id ─────────────────────────────────
  server.registerResource(
    "product",
    new ResourceTemplate("tracepass://product/{id}", { list: undefined }),
    {
      title: "Product",
      description:
        "One TracePass product by its id — tracepass://product/{id}.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const res = await client.get(`/api/v1/products/${encodeURIComponent(id)}`);
      return res.ok
        ? jsonContents(uri.href, res.body)
        : errorContents(uri.href, res.status, res.body);
    },
  );

  // ── Template: a passport by id ────────────────────────────────
  server.registerResource(
    "passport",
    new ResourceTemplate("tracepass://passport/{id}", { list: undefined }),
    {
      title: "Digital Product Passport",
      description:
        "One DPP by its id, full field detail — tracepass://passport/{id}. Attach this to give the model a passport's complete state.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const res = await client.get(
        `/api/v1/passports/${encodeURIComponent(id)}?format=full`,
      );
      return res.ok
        ? jsonContents(uri.href, res.body)
        : errorContents(uri.href, res.status, res.body);
    },
  );

  // ── Template: a passport's EPCIS event history ────────────────
  server.registerResource(
    "passport-epcis",
    new ResourceTemplate("tracepass://passport/{id}/epcis", {
      list: undefined,
    }),
    {
      title: "Passport EPCIS events",
      description:
        "A passport's supply-chain event history as an EPCIS 2.0 JSON-LD document — tracepass://passport/{id}/epcis.",
      mimeType: "application/ld+json",
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const res = await client.get(
        `/api/v1/passports/${encodeURIComponent(id)}/epcis`,
      );
      return res.ok
        ? jsonContents(uri.href, res.body)
        : errorContents(uri.href, res.status, res.body);
    },
  );
}
