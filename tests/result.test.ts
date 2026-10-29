import { describe, it, expect } from "vitest";
import { apiResult, textResult, jsonResult, errorResult } from "../src/result.js";
import { credentialAccepted } from "../src/http.js";
import { vi, afterEach } from "vitest";

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

  it("402 → payment-required message that says do not retry, with no overage offer", () => {
    const r = apiResult({
      status: 402,
      ok: false,
      body: { error: "epcis_events_overage_required", message: "Plan includes 10 events a month." },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Plan includes 10 events a month.");
    expect(r.content[0]!.text).toContain("epcis_events_overage_required");
    expect(r.content[0]!.text).toMatch(/do not retry/i);
    // No tool forwards confirmOverage, so the message must not offer it.
    expect(r.content[0]!.text).not.toMatch(/confirmOverage/);
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

  it("409 with a code and no message names the code, not a duplicate-data guess", () => {
    const r = apiResult({ status: 409, ok: false, body: { error: "already_placed" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("already_placed");
    expect(r.content[0]!.text).not.toMatch(/duplicate GTIN/);
  });

  it("409 carries findings[] through to the agent", () => {
    const r = apiResult({
      status: 409,
      ok: false,
      body: { error: "registry_not_ready", findings: ['Required field "carbonFootprintTotal" has no value.'] },
    });
    expect(r.content[0]!.text).toContain("registry_not_ready");
    expect(r.content[0]!.text).toContain('Required field "carbonFootprintTotal" has no value.');
  });

  it("409 with a message keeps the message and adds the code", () => {
    const r = apiResult({
      status: 409,
      ok: false,
      body: { error: "operator_locked", message: "Operator and facility identifiers are locked after Place on market." },
    });
    expect(r.content[0]!.text).toContain("operator_locked");
    expect(r.content[0]!.text).toContain("locked after Place on market");
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

describe("403 about the account, not the plan", () => {
  it("an inactive subscription says resolve billing, never re-authorise or change plan", () => {
    const r = apiResult({ status: 403, ok: false, body: { error: "Subscription is not active" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/resolve billing/i);
    expect(r.content[0]!.text).not.toMatch(/plan change/i);
  });

  it("a plan-tier 403 keeps the plan-change text", () => {
    const r = apiResult({ status: 403, ok: false, body: { error: "epcis_capture_not_available" } });
    expect(r.content[0]!.text).toMatch(/plan change/i);
  });
});

describe("credential probe", () => {
  // A 403 used to count as a rejected credential, so the endpoint answered an
  // inactive account with an invalid_token challenge and clients asked the user
  // to re-authorise, which can never help.
  afterEach(() => vi.unstubAllGlobals());
  const probeWith = (status: number) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    return credentialAccepted("tp_test");
  };

  it("rejects only a 401", async () => {
    expect(await probeWith(401)).toBe(false);
  });

  it("lets a 403 (inactive subscription, API access off, missing scope) through to the tool", async () => {
    expect(await probeWith(403)).toBe(true);
  });

  it("does not block on a transient failure", async () => {
    expect(await probeWith(503)).toBe(true);
  });
});
