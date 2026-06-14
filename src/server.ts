/**
 * The TracePass MCP server factory.
 *
 * `createMcpServer(config)` builds an `McpServer` with every
 * TracePass tool registered, bound to an API client. It is
 * TRANSPORT-AGNOSTIC — it knows nothing about stdio vs HTTP. The
 * caller connects it to a transport:
 *   - the hosted `/mcp` route → WebStandardStreamableHTTPServerTransport
 *   - the standalone npm package → StdioServerTransport
 *
 * One factory, every transport — so the tool surface can never
 * drift between the hosted endpoint and the local package.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TracePassClient } from "./api-client.js";
import { buildTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { errorResult } from "./result.js";

/** Server identity reported to MCP clients. Bump `version` on a
 *  meaningful tool-surface change. */
export const MCP_SERVER_INFO = {
  name: "tracepass",
  version: "1.4.2",
} as const;

export interface CreateMcpServerConfig {
  /** Base URL of the TracePass app — e.g. "https://app.tracepass.eu".
   *  The hosted route passes its own origin; the npm package passes
   *  the public URL (or a customer override). */
  baseUrl: string;
  /** The caller's tp_ API key — every v1 call is made as this key. */
  apiKey: string;
}

/**
 * Build a fully-wired TracePass `McpServer`. The caller is
 * responsible for connecting it to a transport via `.connect()`.
 */
export function createMcpServer(config: CreateMcpServerConfig): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      "Tools for the TracePass Digital Product Passport platform. " +
      "Reads are free; writes that create passports are billable and " +
      "consume plan quota — never create passports in bulk or accept " +
      "an overage charge without the user's explicit consent. " +
      "archive_passport is irreversible; prefer suspend_passport when " +
      "a change might need undoing.",
  });

  const client = new TracePassClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });

  for (const tool of buildTools(client)) {
    // The SDK passes validated args (typed from the Zod shape) as the
    // first param + a RequestHandlerExtra second param we don't use.
    // A handler that throws would surface as an opaque protocol
    // error, so we catch and convert to a readable isError result.
    // The result is cast to the SDK's CallToolResult — our ToolResult
    // is a structurally-compatible subset (text content only).
    const cb = async (args: Record<string, unknown>) => {
      try {
        return await tool.handler(args);
      } catch (err) {
        return errorResult(
          `Tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb as any,
    );
  }

  // Resources (entity data the user attaches as context) + prompts
  // (reusable DPP workflows the client surfaces as slash-commands).
  // `ping` and capability negotiation are handled by the SDK itself
  // once a transport is connected — no wiring needed.
  registerResources(server, client);
  registerPrompts(server);

  return server;
}
