import { describe, it, expect } from "vitest";
import { buildSupplierTools, matchSupplierPath, supplierResult } from "../src/supplier-server.js";
import type { TracePassClient } from "../src/api-client.js";

function stubClient(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const respond = async (method: string, path: string, b?: unknown) => {
    calls.push({ method, path, body: b });
    return { status, ok: status < 300, body };
  };
  const client = {
    get: (p: string) => respond("GET", p),
    post: (p: string, b?: unknown) => respond("POST", p, b),
  } as unknown as TracePassClient;
  return { client, calls };
}

const tool = (tools: ReturnType<typeof buildSupplierTools>, name: string) => tools.find((t) => t.name === name)!;

describe("supplier tool surface", () => {
  it("exposes exactly the five supplier tools and none of the customer tools", () => {
    const names = buildSupplierTools(stubClient().client, true).map((t) => t.name).sort();
    expect(names).toEqual(["get_request", "get_review_status", "submit_answers", "upload_evidence", "validate_answers"]);
  });

  it("routes each tool to its supplier API endpoint", async () => {
    const { client, calls } = stubClient();
    const tools = buildSupplierTools(client, true);
    await tool(tools, "get_request").handler({ lang: "de" });
    await tool(tools, "validate_answers").handler({ fieldValues: { a: 1 } });
    await tool(tools, "upload_evidence").handler({ filename: "d.pdf", mimeType: "application/pdf", contentBase64: "eA==" });
    await tool(tools, "submit_answers").handler({ fieldValues: { a: 1 }, evidence: { a: { note: "p.2" } } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/supplier/v1/request?lang=de",
      "POST /api/supplier/v1/validate",
      "POST /api/supplier/v1/documents",
      "POST /api/supplier/v1/submit",
    ]);
    expect(calls[3]!.body).toEqual({ fieldValues: { a: 1 }, evidence: { a: { note: "p.2" } } });
  });

  it("drops a lang value that is not a language code", async () => {
    const { client, calls } = stubClient();
    await tool(buildSupplierTools(client, true), "get_request").handler({ lang: "de&x=1" });
    expect(calls[0]!.path).toBe("/api/supplier/v1/request");
  });

  it("without a token, every tool explains how to connect and makes no call", async () => {
    const { client, calls } = stubClient();
    for (const t of buildSupplierTools(client, false)) {
      const r = await t.handler({ fieldValues: {} });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("/supplier/mcp/<token>");
    }
    expect(calls).toEqual([]);
  });

  it("get_review_status reduces the request to its outcome", async () => {
    const { client } = stubClient(200, {
      request: { status: "accepted", canSubmit: false, linkExpiresAt: "2026-10-25" },
      submission: { revision: 2, updatedAt: "2026-09-25" },
      review: { outcome: "accepted", acceptedFields: ["a"] },
      fields: [{ key: "a" }],
    });
    const r = await tool(buildSupplierTools(client, true), "get_review_status").handler({});
    expect(r.structuredContent).toEqual({
      status: "accepted",
      canStillChangeAnswers: false,
      linkExpiresAt: "2026-10-25",
      submittedRevision: 2,
      lastSubmittedAt: "2026-09-25",
      review: { outcome: "accepted", acceptedFields: ["a"] },
    });
  });
});

describe("supplierResult — supplier wording, never API keys or plans", () => {
  it.each([401, 404, 409, 410, 413, 429])("%i is an error without customer jargon", (status) => {
    const r = supplierResult({ status, ok: false, body: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toMatch(/API key|plan/i);
  });

  it("410 says the request expired or was cancelled", () => {
    expect(supplierResult({ status: 410, ok: false, body: {} }).content[0]!.text).toMatch(/expired or was cancelled/);
  });
});

describe("matchSupplierPath", () => {
  const token = "c86594f355692145e0431a645b195d48920c3e91d74fd71e7e053bbafc93c670";
  it("takes the token from the path", () => expect(matchSupplierPath(`/supplier/mcp/${token}`)).toEqual({ pathToken: token }));
  it("accepts a trailing slash", () => expect(matchSupplierPath(`/supplier/mcp/${token}/`)).toEqual({ pathToken: token }));
  it("leaves the token to the header on the bare path", () => expect(matchSupplierPath("/supplier/mcp")).toEqual({ pathToken: "" }));
  it("rejects a segment that is not a token", () => {
    expect(matchSupplierPath("/supplier/mcp/short")).toBeNull();
    expect(matchSupplierPath(`/supplier/mcp/${token}/extra`)).toBeNull();
    expect(matchSupplierPath("/supplier/mcp/..%2F..%2Fetc")).toBeNull();
  });
  it("does not match the customer endpoint", () => expect(matchSupplierPath("/mcp")).toBeNull());
});
