import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../src/server.js";
import { createSupplierMcpServer } from "../src/supplier-server.js";
import { buildTools } from "../src/tools.js";
import type { TracePassClient } from "../src/api-client.js";

/**
 * AI-client directories (Claude connectors, OpenAI) review a tool by its
 * annotations: a title, plus readOnlyHint / destructiveHint / openWorldHint set
 * explicitly. These tests read them the way a client does, over tools/list, and
 * check each hint against what the tool's actions actually do.
 */

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

async function listTools(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "annotations-test", version: "0.0.0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe.each([
  ["main /mcp", () => createMcpServer({ baseUrl: "https://app.example", apiKey: "tp_test" })],
  ["supplier", () => createSupplierMcpServer({ baseUrl: "https://app.example", token: "" })],
])("%s server — tools/list annotations", (_, make) => {
  it("every tool has a title and all four hints as explicit booleans", async () => {
    const tools = await listTools(make());
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      for (const hint of HINTS) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("no tool reaches outside the TracePass account", async () => {
    for (const tool of await listTools(make())) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  it("a read-only tool is never marked destructive", async () => {
    for (const tool of await listTools(make())) {
      if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });
});

// A hint describes the whole tool, so it must hold for its riskiest action.
// Writes: anything that creates, changes or captures. Destructive: anything
// that overwrites, removes, suspends or archives (not purely additive).
const WRITE = /^(create|update|archive|suspend|set|remove|capture$|capture_by|capture_measurements)/;
const DESTRUCTIVE = /^(update|archive|suspend|set|remove)/;

describe("main /mcp server — hints match the action enums", () => {
  const tools = buildTools({} as TracePassClient);
  const actionsOf = (t: (typeof tools)[number]) =>
    (t.inputSchema.action as unknown as { options: string[] }).options;

  it.each(tools.map((t) => [t.name, t] as const))("%s", (_, tool) => {
    const actions = actionsOf(tool);
    expect(actions.length).toBeGreaterThan(0);
    expect(tool.annotations.readOnlyHint).toBe(!actions.some((a) => WRITE.test(a)));
    expect(tool.annotations.destructiveHint).toBe(actions.some((a) => DESTRUCTIVE.test(a)));
  });

  it("classifies the read actions that share a write prefix as reads", () => {
    expect(WRITE.test("capture_job")).toBe(false);
    expect(WRITE.test("capture")).toBe(true);
    expect(WRITE.test("capture_measurements_by_serial")).toBe(true);
  });
});
