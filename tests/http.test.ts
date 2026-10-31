/**
 * HTTP-layer security regression tests.
 *
 * These tests start a real Node HTTP server on port 0 (random) and exercise
 * the request handler exported by src/http.ts. They lock in three of the
 * SEC-08 fixes so a regression re-opens a gap that fails here before it
 * ships:
 *
 *  1. GET and DELETE on MCP endpoints → 405 (stateless — no session to
 *     resume; without this check the SDK opens an infinite SSE stream and
 *     the old `await webRes.text()` call blocked forever, leaking ~180 KB
 *     per connection).
 *
 *  2. Request body > 1 MB → 413 (body cap prevents OOM on the server).
 *
 *  3. JSON-RPC batch > 10 messages → 400 batch_too_large (batch cap prevents
 *     event-loop exhaustion from parsing/validating huge batches).
 *
 * Proven-red protocol (owner rule): for each test, the fix was temporarily
 * reverted and the test was confirmed to FAIL before re-applying the fix.
 *
 * - GET → 405: with the `method !== "POST"` guard removed, the SDK returns
 *   200 SSE (with `Accept: text/event-stream`) — the assertion on 405 fails.
 * - Body cap → 413: with the BODY_LIMIT_BYTES guard removed from readBody,
 *   the server accepts the oversized body — the assertion on 413 fails.
 * - Batch cap → 400: with the batch-size guard removed, the 11-item batch
 *   reaches the SDK and returns 200 — the assertion on 400 fails.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { requestHandler } from "../src/http.js";

/** Start the MCP request handler on a random port. Returns port + close fn. */
function startTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(requestHandler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.once("error", reject);
  });
}

// ── SEC-08: GET / DELETE → 405 ────────────────────────────────────────────────
describe("SEC-08 — non-POST methods on MCP endpoints return 405", () => {
  let srv: { port: number; close: () => Promise<void> };

  beforeEach(async () => { srv = await startTestServer(); });
  afterEach(async () => { await srv.close(); });

  it("GET /mcp returns 405 with Allow: POST (not a hanging SSE stream)", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(2000), // must respond before the timeout
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    await res.body?.cancel();
  });

  it("DELETE /mcp returns 405", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "DELETE",
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(405);
    await res.body?.cancel();
  });

  it("GET /compliance/mcp returns 405", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/compliance/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(405);
    await res.body?.cancel();
  });

  it("GET /supplier/mcp returns 405 (path without token)", async () => {
    // /supplier/mcp (no token in path) also matches the supplier handler
    const res = await fetch(`http://127.0.0.1:${srv.port}/supplier/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(405);
    await res.body?.cancel();
  });
});

// ── SEC-08: body size cap → 413 ───────────────────────────────────────────────
describe("SEC-08 — oversized request body returns 413", () => {
  let srv: { port: number; close: () => Promise<void> };

  beforeEach(async () => { srv = await startTestServer(); });
  afterEach(async () => { await srv.close(); });

  it("POST /mcp body > 1 MB returns 413 request_too_large", async () => {
    // Default limit is 1 048 576 bytes; send 1 byte over.
    const oversizedBody = "x".repeat(1_048_577);
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(413);
    const json = await res.json() as Record<string, string>;
    expect(json.error).toBe("request_too_large");
  });
});

// ── SEC-08: JSON-RPC batch cap → 400 ─────────────────────────────────────────
describe("SEC-08 — oversized JSON-RPC batch returns 400", () => {
  let srv: { port: number; close: () => Promise<void> };

  beforeEach(async () => { srv = await startTestServer(); });
  afterEach(async () => { await srv.close(); });

  it("batch of 11 tools/list messages returns 400 batch_too_large", async () => {
    const batch = Array.from({ length: 11 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/list",
      params: {},
    }));
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, string>;
    expect(json.error).toBe("batch_too_large");
  });

  it("batch of exactly 10 messages is NOT rejected with batch_too_large", async () => {
    const batch = Array.from({ length: 10 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/list",
      params: {},
    }));
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5000),
    });
    // The batch passes the cap check — whatever the SDK returns, it is not 400.
    expect(res.status).not.toBe(400);
  });
});
