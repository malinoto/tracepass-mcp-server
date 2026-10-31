/**
 * createMcpServer — error-sanitization regression test.
 *
 * SEC-08 (raw error messages): the original server.ts catch block surfaced
 * raw `err.message` in the tool result:
 *
 *   return errorResult(`Tool "${tool.name}" failed: ${err.message}`);
 *
 * If err.message contains an internal path, a database password, or a
 * stack-frame URL, that text would leak to the caller. The fix logs the
 * detail server-side with a random reference id and returns only a generic
 * message to the client.
 *
 * Proven-red: with the original one-liner catch, the test fails because
 * "SECRET_DB_CREDENTIAL" appears verbatim in the tool result text.
 * After the fix the result contains only "failed unexpectedly (ref: <eid>)".
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";

describe("createMcpServer — error sanitization (SEC-08)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a network error from a tool handler does NOT leak the raw message to the caller", async () => {
    // Simulate an internal fetch failure whose message contains a "secret".
    // Without the fix this exact string would appear in the tool result.
    const secretMsg = "SECRET_DB_CREDENTIAL=hunter2 at /internal/path/db.ts:42";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(secretMsg));

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      baseUrl: "https://app.example",
      apiKey: "tp_test",
    });
    await server.connect(serverSide);

    const client = new Client({ name: "sanitization-test", version: "0.0.0" });
    await client.connect(clientSide);

    // tools/list → connect; tracepass_products list → triggers a fetch call
    const result = await client.callTool({
      name: "tracepass_products",
      arguments: { action: "list", args: {} },
    });

    await client.close();

    // The SDK wraps isError results in a content array of text parts.
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");

    // Raw error MUST NOT reach the caller.
    expect(text).not.toContain("SECRET_DB_CREDENTIAL");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("/internal/path");

    // Generic "ref: <eid>" message MUST be present so the caller can
    // correlate with server-side logs.
    expect(text).toMatch(/failed unexpectedly \(ref: [a-z0-9]+\)/);
  });
});
