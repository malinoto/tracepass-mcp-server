import { afterEach, describe, expect, it, vi } from "vitest";
import { TracePassClient, clientIpFromForwardedFor } from "../src/api-client.js";

/**
 * Hosted, every MCP user reaches the platform from the MCP container's
 * address, so without the forwarded IP they all share one per-IP rate-limit
 * bucket on the platform. The client forwards the end user's IP — and only
 * something that parses as an IP.
 */
describe("clientIpFromForwardedFor", () => {
  it("takes the first entry of the inbound header", () => {
    expect(clientIpFromForwardedFor("203.0.113.7, 10.0.0.2")).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("2001:db8::1")).toBe("2001:db8::1");
    expect(clientIpFromForwardedFor(["198.51.100.4", "10.0.0.1"])).toBe("198.51.100.4");
  });

  it("drops anything that is not an IP", () => {
    expect(clientIpFromForwardedFor(undefined)).toBeUndefined();
    expect(clientIpFromForwardedFor("")).toBeUndefined();
    expect(clientIpFromForwardedFor("unknown")).toBeUndefined();
    expect(clientIpFromForwardedFor("evil.example\r\nX-Injected: 1")).toBeUndefined();
  });
});

describe("TracePassClient forwards the end user's IP", () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureHeaders(): { headers: () => Record<string, string> } {
    let seen: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      }),
    );
    return { headers: () => seen };
  }

  it("sends X-Forwarded-For when the hosted transport supplies one", async () => {
    const cap = captureHeaders();
    const client = new TracePassClient({
      baseUrl: "http://platform:3000",
      apiKey: "tp_x",
      forwardedFor: "203.0.113.7",
    });
    await client.request("GET", "/api/v1/templates");
    expect(cap.headers()["X-Forwarded-For"]).toBe("203.0.113.7");
  });

  it("sends none when there is no client IP (stdio)", async () => {
    const cap = captureHeaders();
    const client = new TracePassClient({ baseUrl: "https://app.tracepass.eu", apiKey: "tp_x" });
    await client.request("GET", "/api/v1/templates");
    expect(cap.headers()["X-Forwarded-For"]).toBeUndefined();
  });
});
