#!/usr/bin/env node
/**
 * stdio entrypoint — the local / npx form of the TracePass MCP
 * server.
 *
 * An MCP client (Claude Desktop, Cursor, an IDE agent) launches this
 * as a subprocess and speaks MCP over stdin/stdout. The API key and
 * the TracePass base URL come from environment variables the client
 * sets in its server config:
 *
 *   TRACEPASS_API_KEY    (required) — a tp_ API key
 *   TRACEPASS_BASE_URL   (optional) — defaults to https://app.tracepass.eu
 *
 * This is the SAME server core (`createMcpServer`) the hosted HTTP
 * service uses — only the transport differs.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

const DEFAULT_BASE_URL = "https://app.tracepass.eu";

async function main(): Promise<void> {
  const apiKey = process.env.TRACEPASS_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    // Warn but DON'T exit: the server must still start and list its
    // tools so introspecting clients (Glama, Smithery, MCP inspectors)
    // can enumerate capabilities without a key. The key is enforced at
    // tool-call time (see TracePassClient.request). Write to stderr —
    // stdout is the MCP protocol channel and must carry only JSON-RPC.
    process.stderr.write(
      "tracepass-mcp-server: TRACEPASS_API_KEY is not set. The server " +
        "will start and list tools, but tool calls will fail until you " +
        "add a tp_ key (TracePass dashboard → Developer → API Keys) to " +
        "the MCP server's env config.\n",
    );
  }

  const baseUrl = process.env.TRACEPASS_BASE_URL?.trim() || DEFAULT_BASE_URL;

  const server = createMcpServer({ apiKey, baseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The process now stays alive serving MCP over stdio until the
  // client closes the pipe.
}

main().catch((err) => {
  process.stderr.write(
    `tracepass-mcp-server: fatal — ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
