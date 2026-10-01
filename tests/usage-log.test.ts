import { describe, it, expect } from "vitest";
import { authKind, summarizeRpc, usageLogLine } from "../src/usage-log.js";

describe("usage log", () => {
  it("classifies the credential without keeping it", () => {
    expect(authKind(undefined)).toBe("none");
    expect(authKind("tp_abc123")).toBe("api_key");
    expect(authKind("eyJhbGciOi...")).toBe("oauth");
  });

  it("names the tool and action of a tools/call, never its other arguments", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "tracepass_passports", arguments: { action: "get", args: { id: "secret-id" } } },
    });
    const s = summarizeRpc(body, "tp_k");
    expect(s).toEqual({ methods: ["tools/call"], tools: [{ name: "tracepass_passports", action: "get" }], auth: "api_key" });
    expect(JSON.stringify(s)).not.toContain("secret-id");
  });

  it("handles batches, discovery methods and unparseable bodies", () => {
    expect(summarizeRpc(JSON.stringify([{ method: "initialize" }, { method: "tools/list" }]), null).methods).toEqual(["initialize", "tools/list"]);
    expect(summarizeRpc("{not json", null).methods).toEqual(["<unparseable>"]);
    expect(summarizeRpc(undefined, null)).toEqual({ methods: [], tools: [], auth: "none" });
  });

  it("writes a prefixed line with no IP or token", () => {
    const line = usageLogLine({
      at: new Date("2026-10-01T10:00:00Z"), endpoint: "mcp", httpMethod: "POST", status: 200,
      userAgent: "claude-code/2.0", summary: summarizeRpc(JSON.stringify({ method: "tools/list" }), "tp_secretkey"),
    });
    expect(line.startsWith("mcp_usage {")).toBe(true);
    const j = JSON.parse(line.slice("mcp_usage ".length));
    expect(j).toMatchObject({ ep: "mcp", status: 200, auth: "api_key", rpc: ["tools/list"], ua: "claude-code/2.0" });
    expect(line).not.toContain("tp_secretkey");
  });
});
