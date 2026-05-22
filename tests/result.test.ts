import { describe, it, expect } from "vitest";
import { apiResult, textResult, jsonResult, errorResult } from "../src/result.js";

describe("textResult / jsonResult / errorResult", () => {
  it("textResult wraps a string", () => {
    const r = textResult("hello");
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.isError).toBeUndefined();
  });

  it("jsonResult pretty-prints and carries structuredContent for objects", () => {
    const r = jsonResult({ a: 1 });
    expect(r.content[0]!.text).toContain('"a": 1');
    expect(r.structuredContent).toEqual({ a: 1 });
  });

  it("jsonResult wraps a non-object under `result`", () => {
    const r = jsonResult([1, 2]);
    expect(r.structuredContent).toEqual({ result: [1, 2] });
  });

  it("errorResult sets isError", () => {
    expect(errorResult("nope").isError).toBe(true);
  });
});

describe("apiResult — status mapping", () => {
  it("2xx → success json result", () => {
    const r = apiResult({ status: 200, ok: true, body: { id: "p1" } });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("p1");
  });

  it("401 → auth error", () => {
    const r = apiResult({ status: 401, ok: false, body: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/authentication failed/i);
  });

  it("402 → overage message that explains confirmOverage", () => {
    const r = apiResult({
      status: 402,
      ok: false,
      body: { error: "overage_required", message: "Plan includes 150 DPPs." },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Plan includes 150 DPPs.");
    expect(r.content[0]!.text).toMatch(/confirmOverage: true/);
  });

  it("403 → plan-gate error that says do not retry", () => {
    const r = apiResult({
      status: 403,
      ok: false,
      body: { error: "epcis_capture_not_available", message: "EPCIS add-on required." },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("epcis_capture_not_available");
    expect(r.content[0]!.text).toMatch(/do not retry/i);
  });

  it("404 → not-found error", () => {
    const r = apiResult({ status: 404, ok: false, body: { message: "no such passport" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not found/i);
  });

  it("409 → conflict error", () => {
    const r = apiResult({ status: 409, ok: false, body: {} });
    expect(r.content[0]!.text).toMatch(/conflict/i);
  });

  it("429 → rate-limit error mentioning the UTC reset", () => {
    const r = apiResult({ status: 429, ok: false, body: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/rate limit/i);
    expect(r.content[0]!.text).toMatch(/00:00 UTC/);
  });

  it("500 → generic error carrying the status", () => {
    const r = apiResult({ status: 500, ok: false, body: { message: "boom" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("500");
  });
});
