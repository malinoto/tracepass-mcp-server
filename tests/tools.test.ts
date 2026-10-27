import { describe, it, expect } from "vitest";
import { buildTools } from "../src/tools.js";
import type { TracePassClient } from "../src/api-client.js";

/**
 * A stub TracePassClient that records the calls the tool handlers
 * make, and returns a canned 200. Lets us assert routing + arg
 * validation without real HTTP.
 */
function stubClient(): {
  client: TracePassClient;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const ok = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; ok: boolean; body: unknown }> => {
    calls.push({ method, path, body });
    return { status: 200, ok: true, body: { ok: true } };
  };
  const client = {
    get: (p: string) => ok("GET", p),
    post: (p: string, b?: unknown) => ok("POST", p, b),
    patch: (p: string, b?: unknown) => ok("PATCH", p, b),
    delete: (p: string) => ok("DELETE", p),
    request: (m: string, p: string, b?: unknown) => ok(m, p, b),
  } as unknown as TracePassClient;
  return { client, calls };
}

describe("buildTools — tool surface", () => {
  it("exposes exactly 7 grouped tools", () => {
    const { client } = stubClient();
    const tools = buildTools(client);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "tracepass_epcis",
      "tracepass_passport_fields",
      "tracepass_passport_parties",
      "tracepass_passports",
      "tracepass_products",
      "tracepass_scope",
      "tracepass_templates",
    ]);
  });

  it("the server card (src/http.ts) lists exactly the tools the server registers", async () => {
    // http.ts starts a listener on import, so read its card's tool list from the source.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/http.ts", import.meta.url), "utf8");
    const block = /capabilities:\s*\{\s*tools:\s*\[([^\]]*)\]/.exec(src)?.[1] ?? "";
    const card = [...block.matchAll(/"(tracepass_[a-z_]+)"/g)].map((m) => m[1]).sort();
    const { client } = stubClient();
    expect(card).toEqual(buildTools(client).map((t) => t.name).sort());
  });

  it("every tool has an action enum + an args field in its schema", () => {
    const { client } = stubClient();
    for (const t of buildTools(client)) {
      expect(t.inputSchema.action).toBeDefined();
      expect(t.inputSchema.args).toBeDefined();
    }
  });
});

describe("tracepass_products — action routing", () => {
  function productsTool() {
    const stub = stubClient();
    const tool = buildTools(stub.client).find((t) => t.name === "tracepass_products")!;
    return { tool, calls: stub.calls };
  }

  it("list routes to GET /api/v1/products", async () => {
    const { tool, calls } = productsTool();
    await tool.handler({ action: "list", args: { limit: 10 } });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/products?limit=10");
  });

  it("get routes to GET /api/v1/products/{id}", async () => {
    const { tool, calls } = productsTool();
    await tool.handler({ action: "get", args: { id: "p1" } });
    expect(calls[0]!.path).toBe("/api/v1/products/p1");
  });

  it("create POSTs the product body", async () => {
    const { tool, calls } = productsTool();
    await tool.handler({
      action: "create",
      args: { name: "Cell", model: "X", category: "battery" },
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({ name: "Cell", category: "battery" });
  });

  it("create with missing required args returns an isError result, no HTTP call", async () => {
    const { tool, calls } = productsTool();
    const r = await tool.handler({ action: "create", args: { name: "Cell" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("an unknown action returns an isError result", async () => {
    const { tool } = productsTool();
    const r = await tool.handler({ action: "frobnicate", args: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Unknown action/);
  });
});

describe("tracepass_passports — create + lifecycle actions", () => {
  function passportsTool() {
    const stub = stubClient();
    const tool = buildTools(stub.client).find((t) => t.name === "tracepass_passports")!;
    return { tool, calls: stub.calls };
  }

  // ── legacy GS1 path (backward-compat) ──
  it("create builds the gs1 nested body when legacy gtin+serialNumber provided", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: { productId: "p1", gtin: "09506000134369", serialNumber: "SN-1" },
    });
    expect(calls[0]!.body).toMatchObject({
      productId: "p1",
      gs1: { gtin: "09506000134369", serialNumber: "SN-1" },
    });
    // identifier must NOT be present on the legacy path
    expect((calls[0]!.body as Record<string, unknown>).identifier).toBeUndefined();
  });

  it("create sends no confirmOverage: a draft takes no plan slot", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: { productId: "p1", gtin: "1", serialNumber: "s", confirmOverage: true },
    });
    expect((calls[0]!.body as Record<string, unknown>).confirmOverage).toBeUndefined();
  });

  it("no tool description calls passport create billable", () => {
    const passports = buildTools(stubClient().client).find((t) => t.name === "tracepass_passports")!;
    expect(passports.description).not.toMatch(/BILLABLE|confirmOverage/);
    expect(passports.description).toMatch(/DRAFT passport/);
  });

  // ── battery measurements (living record) ──
  it("capture_measurements posts the measurements to the passport", async () => {
    const { tool, calls } = passportsTool();
    const measurements = [{ fieldKey: "stateOfHealth", value: 96.4, measuredAt: "2027-03-01T06:00:00Z", externalId: "m1" }];
    await tool.handler({ action: "capture_measurements", args: { id: "p1", measurements } });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/passports/p1/measurements", body: { measurements } });
  });

  it("capture_measurements_by_serial carries the gtin disambiguator", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "capture_measurements_by_serial",
      args: { serial: "SN 1", gtin: "09506000134369", measurements: [{ fieldKey: "stateOfHealth", value: 90, measuredAt: "2027-03-01T06:00:00Z" }] },
    });
    expect(calls[0]!.path).toBe("/api/v1/passports/by-serial/SN%201/measurements?gtin=09506000134369");
  });

  it("capture_measurements refuses an empty or oversized batch before calling the API", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({ action: "capture_measurements", args: { id: "p1", measurements: [] } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("list_measurements passes filters as query parameters", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "list_measurements", args: { id: "p1", fieldKey: "stateOfHealth", limit: 10 } });
    expect(calls[0]!.path).toMatch(/^\/api\/v1\/passports\/p1\/measurements\?/);
    expect(calls[0]!.path).toContain("fieldKey=stateOfHealth");
    expect(calls[0]!.path).toContain("limit=10");
  });

  it("latest_measurements reads the latest endpoint", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "latest_measurements", args: { id: "p1" } });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/passports/p1/measurements/latest" });
  });

  // ── battery lineage (Art. 77(7)) ──
  it("create forwards a lineage block", async () => {
    const { tool, calls } = passportsTool();
    const lineage = { predecessors: [{ internalPassportId: "6650a1b2c3d4e5f6a7b8c9d0", trigger: "repurposing" }] };
    await tool.handler({
      action: "create",
      args: { productId: "p1", gtin: "09506000134369", serialNumber: "SN-2", lineage },
    });
    expect(calls[0]!.body).toMatchObject({ lineage });
  });

  it("create rejects a predecessor with neither identifier nor internalPassportId", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({
      action: "create",
      args: { productId: "p1", gtin: "1", serialNumber: "s", lineage: { predecessors: [{ trigger: "repurposing" }] } },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("create sends no lineage key when none is given", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "create", args: { productId: "p1", gtin: "1", serialNumber: "s" } });
    expect((calls[0]!.body as Record<string, unknown>).lineage).toBeUndefined();
  });

  // ── EN 18219 identifier paths ──
  it("create with identifier gs1 sends identifier (not legacy gs1 block)", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: {
        productId: "p1",
        identifier: { scheme: "gs1", gtin: "09506000134369", serialNumber: "SN-1" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      productId: "p1",
      identifier: { scheme: "gs1", gtin: "09506000134369", serialNumber: "SN-1" },
    });
    expect((calls[0]!.body as Record<string, unknown>).gs1).toBeUndefined();
  });

  it("create with identifier iso15459 sends identifier block", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: {
        productId: "p2",
        identifier: {
          scheme: "iso15459",
          issuingAgencyCode: "MFR",
          primaryId: "1234567890",
          raw: "MFR1234567890",
        },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      productId: "p2",
      identifier: { scheme: "iso15459", issuingAgencyCode: "MFR", primaryId: "1234567890" },
    });
  });

  it("create with identifier iec61406 sends identifier block", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: {
        productId: "p3",
        identifier: { scheme: "iec61406", uri: "https://id.example.com/product/42" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      identifier: { scheme: "iec61406", uri: "https://id.example.com/product/42" },
    });
  });

  it("create with identifier did sends identifier block", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: {
        productId: "p4",
        identifier: { scheme: "did", did: "did:example:123abc", method: "example" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      identifier: { scheme: "did", did: "did:example:123abc", method: "example" },
    });
  });

  it("create with identifier doi sends identifier block including granularity", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: {
        productId: "p5",
        identifier: { scheme: "doi", doi: "10.1234/example", granularity: "item" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      identifier: { scheme: "doi", doi: "10.1234/example", granularity: "item" },
    });
  });

  it("create with identifier doi without granularity returns a validation error (EN 18219 §5.6.2(b))", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({
      action: "create",
      args: {
        productId: "p5",
        identifier: { scheme: "doi", doi: "10.1234/example" },
      },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("create with identifier doi accepts all three granularity values", async () => {
    const { tool, calls } = passportsTool();
    for (const granularity of ["model", "batch", "item"] as const) {
      calls.length = 0;
      const r = await tool.handler({
        action: "create",
        args: {
          productId: "p5",
          identifier: { scheme: "doi", doi: "10.1234/example", granularity },
        },
      });
      expect(r.isError).toBeFalsy();
      expect(calls[0]!.body).toMatchObject({ identifier: { granularity } });
    }
  });

  it("create with identifier doi passes a prefixed DOI through for the platform to strip", async () => {
    const { tool, calls } = passportsTool();
    for (const doi of ["https://doi.org/10.1234/example", "doi:10.1234/example", "https://dx.doi.org/10.1234/example"]) {
      calls.length = 0;
      const r = await tool.handler({
        action: "create",
        args: { productId: "p5", identifier: { scheme: "doi", doi, granularity: "model" } },
      });
      expect(r.isError).toBeFalsy();
      expect(calls[0]!.body).toMatchObject({ identifier: { doi } });
    }
    const bad = await tool.handler({
      action: "create",
      args: { productId: "p5", identifier: { scheme: "doi", doi: "https://example.com/10.1234/x", granularity: "model" } },
    });
    expect(bad.isError).toBe(true);
  });

  it("create without identifier AND without gtin/serialNumber returns an error", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({ action: "create", args: { productId: "p1" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("create with identifier with unknown scheme returns an error", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({
      action: "create",
      args: { productId: "p1", identifier: { scheme: "rfid", code: "ABCDEF" } },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("archive routes to the archive endpoint", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "archive", args: { id: "x1" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/x1/archive");
    expect(calls[0]!.method).toBe("POST");
  });

  it("compliance routes to a read of the compliance endpoint", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "compliance", args: { id: "x1" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/x1/compliance");
    expect(calls[0]!.method).toBe("GET");
  });

  it("get_by_serial URL-encodes the serial", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "get_by_serial", args: { serial: "LOT 1/A" } });
    expect(calls[0]!.path).toContain("LOT%201%2FA");
  });

  it("archive_by_serial routes to the by-serial archive endpoint", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "archive_by_serial", args: { serial: "SN-1" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/by-serial/SN-1/archive");
    expect(calls[0]!.method).toBe("POST");
  });

  it("suspend_by_serial passes the gtin disambiguator as a query param", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "suspend_by_serial", args: { serial: "SN-1", gtin: "09506000134369" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/by-serial/SN-1/suspend?gtin=09506000134369");
    expect(calls[0]!.method).toBe("POST");
  });

  it("get_qr_by_serial GETs the by-serial qr endpoint with format + gtin", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "get_qr_by_serial",
      args: { serial: "SN-1", format: "png", gtin: "09506000134369" },
    });
    expect(calls[0]!.path).toBe("/api/v1/passports/by-serial/SN-1/qr?format=png&gtin=09506000134369");
    expect(calls[0]!.method).toBe("GET");
  });

  it("list_snapshots GETs the snapshot list with pagination", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "list_snapshots", args: { id: "abc123", page: 2, limit: 10 } });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/passports/abc123/snapshots?page=2&limit=10");
  });

  it("get_qr passes symbology=datamatrix through (EN 18220)", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "get_qr", args: { id: "abc123", format: "png", symbology: "datamatrix" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/abc123/qr?format=png&symbology=datamatrix");
  });

  it("get_qr rejects a symbology the API does not accept, with no HTTP call", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({ action: "get_qr", args: { id: "abc123", symbology: "ean13" } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("list_snapshots passes `at` for a point-in-time read (EN 18221)", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "list_snapshots", args: { id: "abc123", at: "2026-09-29T12:00:00Z" } });
    expect(decodeURIComponent(calls[0]!.path)).toBe("/api/v1/passports/abc123/snapshots?at=2026-09-29T12:00:00Z");
  });

  it("list_snapshots without pagination omits query params", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "list_snapshots", args: { id: "abc123" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/abc123/snapshots");
  });

  it("list_snapshots missing id returns isError, no HTTP call", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({ action: "list_snapshots", args: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("get_snapshot GETs the specific snapshot", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "get_snapshot", args: { id: "abc123", snapshotId: "snap456" } });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/passports/abc123/snapshots/snap456");
  });

  it("get_snapshot missing snapshotId returns isError, no HTTP call", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({ action: "get_snapshot", args: { id: "abc123" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("get_snapshot URL-encodes ids with special chars", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "get_snapshot", args: { id: "abc/xyz", snapshotId: "snap 1" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/abc%2Fxyz/snapshots/snap%201");
  });

  // ── condition flags ──
  it("get_condition_flags GETs the condition-flags endpoint by id", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "get_condition_flags", args: { id: "p1" } });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/passports/p1/condition-flags");
  });

  it("get_condition_flags missing id returns isError, no HTTP call", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({ action: "get_condition_flags", args: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("get_condition_flags_by_serial GETs the by-serial condition-flags endpoint", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "get_condition_flags_by_serial", args: { serial: "SN-1" } });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/passports/by-serial/SN-1/condition-flags");
  });

  it("get_condition_flags_by_serial passes gtin disambiguator as query param", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "get_condition_flags_by_serial",
      args: { serial: "SN-1", gtin: "04012345678901" },
    });
    expect(calls[0]!.path).toBe(
      "/api/v1/passports/by-serial/SN-1/condition-flags?gtin=04012345678901",
    );
  });

  it("set_condition_flags PATCHes the condition-flags endpoint with the flags body", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "set_condition_flags",
      args: { id: "p1", flags: { hasBMS: true, rechargeable: false } },
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe("/api/v1/passports/p1/condition-flags");
    expect(calls[0]!.body).toMatchObject({ hasBMS: true, rechargeable: false });
  });

  it("set_condition_flags supports null (clear) values", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "set_condition_flags",
      args: { id: "p1", flags: { hasBMS: null } },
    });
    expect(calls[0]!.body).toMatchObject({ hasBMS: null });
  });

  it("set_condition_flags missing id returns isError, no HTTP call", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({
      action: "set_condition_flags",
      args: { flags: { hasBMS: true } },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("set_condition_flags missing flags returns isError, no HTTP call", async () => {
    const { tool, calls } = passportsTool();
    const r = await tool.handler({ action: "set_condition_flags", args: { id: "p1" } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("set_condition_flags_by_serial PATCHes the by-serial endpoint with flags", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "set_condition_flags_by_serial",
      args: { serial: "SN-1", flags: { isStationaryBess: true } },
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe("/api/v1/passports/by-serial/SN-1/condition-flags");
    expect(calls[0]!.body).toMatchObject({ isStationaryBess: true });
  });

  it("set_condition_flags_by_serial passes gtin disambiguator as query param", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "set_condition_flags_by_serial",
      args: { serial: "SN-1", gtin: "04012345678901", flags: { hasBMS: true } },
    });
    expect(calls[0]!.path).toBe(
      "/api/v1/passports/by-serial/SN-1/condition-flags?gtin=04012345678901",
    );
  });
});

describe("tracepass_passport_fields — actions", () => {
  function fieldsTool() {
    const stub = stubClient();
    const tool = buildTools(stub.client).find((t) => t.name === "tracepass_passport_fields")!;
    return { tool, calls: stub.calls };
  }

  it("update PATCHes the by-id field endpoint", async () => {
    const { tool, calls } = fieldsTool();
    await tool.handler({ action: "update", args: { id: "p1", fieldKey: "weight", value: 12 } });
    expect(calls[0]!.path).toBe("/api/v1/passports/p1/fields/weight");
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ value: 12 });
  });

  it("update_by_serial PATCHes the by-serial field endpoint with gtin", async () => {
    const { tool, calls } = fieldsTool();
    await tool.handler({ action: "update_by_serial", args: { serial: "SN-1", fieldKey: "weight", value: 12, gtin: "09506000134369" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/by-serial/SN-1/fields/weight?gtin=09506000134369");
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ value: 12 });
  });

  it("refuses a field update with no value on both actions, without calling the API", async () => {
    const { tool, calls } = fieldsTool();
    const byId = await tool.handler({ action: "update", args: { id: "p1", fieldKey: "weight" } });
    const bySerial = await tool.handler({ action: "update_by_serial", args: { serial: "SN-1", fieldKey: "weight" } });
    for (const r of [byId, bySerial]) {
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain("value is required (pass null to clear the field)");
    }
    expect(calls).toHaveLength(0);
  });

  it("sends value: null to clear a field", async () => {
    const { tool, calls } = fieldsTool();
    await tool.handler({ action: "update", args: { id: "p1", fieldKey: "weight", value: null } });
    expect(calls[0]!.body).toEqual({ value: null });
  });

  it("passes a declared source through on both actions", async () => {
    const { tool, calls } = fieldsTool();
    await tool.handler({ action: "update", args: { id: "p1", fieldKey: "weight", value: 12, source: "ai_suggested" } });
    await tool.handler({ action: "update_by_serial", args: { serial: "SN-1", fieldKey: "weight", value: 12, source: "manual" } });
    expect(calls[0]!.body).toEqual({ value: 12, source: "ai_suggested" });
    expect(calls[1]!.body).toEqual({ value: 12, source: "manual" });
  });

  it("rejects an origin the platform reserves, without calling the API", async () => {
    for (const source of ["ai_approved", "system", "company", "supplier"]) {
      const { tool, calls } = fieldsTool();
      const res = await tool.handler({ action: "update", args: { id: "p1", fieldKey: "weight", value: 12, source } });
      expect(res.isError, source).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });
});

describe("tracepass_epcis — actions", () => {
  function epcisTool() {
    const stub = stubClient();
    const tool = buildTools(stub.client).find((t) => t.name === "tracepass_epcis")!;
    return { tool, calls: stub.calls };
  }

  it("export routes to the per-passport epcis endpoint", async () => {
    const { tool, calls } = epcisTool();
    await tool.handler({ action: "export", args: { id: "p1" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/p1/epcis");
  });

  it("export_by_serial routes to the by-serial epcis endpoint (with optional gtin)", async () => {
    const { tool, calls } = epcisTool();
    await tool.handler({ action: "export_by_serial", args: { serial: "SN-1", gtin: "09506000134369" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/by-serial/SN-1/epcis?gtin=09506000134369");
    expect(calls[0]!.method).toBe("GET");
  });

  it("capture POSTs the events payload", async () => {
    const { tool, calls } = epcisTool();
    const events = { type: "EPCISDocument" };
    await tool.handler({ action: "capture", args: { events } });
    expect(calls[0]!.path).toBe("/api/v1/epcis/capture");
    expect(calls[0]!.body).toEqual(events);
  });

  it("query forwards the EPCIS query params", async () => {
    const { tool, calls } = epcisTool();
    await tool.handler({ action: "query", args: { params: { EQ_bizStep: "shipping" } } });
    expect(calls[0]!.path).toBe("/api/v1/epcis/events?EQ_bizStep=shipping");
  });
});

describe("tracepass_passport_parties — set action routing and identifier validation", () => {
  function partiesTool() {
    const stub = stubClient();
    const tool = buildTools(stub.client).find((t) => t.name === "tracepass_passport_parties")!;
    return { tool, calls: stub.calls };
  }

  it("set PATCHes the party endpoint with basic fields", async () => {
    const { tool, calls } = partiesTool();
    await tool.handler({
      action: "set",
      args: { id: "pass1", role: "manufacturer", legalName: "Acme GmbH", gln: "4012345678901" },
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe("/api/v1/passports/pass1/parties/manufacturer");
    expect(calls[0]!.body).toMatchObject({ legalName: "Acme GmbH", gln: "4012345678901" });
  });

  it("set forwards operatorIdentifier iso6523 to the PATCH body", async () => {
    const { tool, calls } = partiesTool();
    await tool.handler({
      action: "set",
      args: {
        id: "pass2",
        role: "importer",
        legalName: "Importer SRL",
        operatorIdentifier: { scheme: "iso6523", icd: "0199", value: "529900T8BM49AURSDO55" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      legalName: "Importer SRL",
      operatorIdentifier: { scheme: "iso6523", icd: "0199", value: "529900T8BM49AURSDO55" },
    });
    expect(calls).toHaveLength(1);
  });

  it("set forwards operatorIdentifier gln to the PATCH body", async () => {
    const { tool, calls } = partiesTool();
    await tool.handler({
      action: "set",
      args: {
        id: "pass3",
        role: "recycler",
        legalName: "Recycler AG",
        operatorIdentifier: { scheme: "gln", gln: "4012345678901" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      operatorIdentifier: { scheme: "gln", gln: "4012345678901" },
    });
  });

  it("set forwards operatorIdentifier did to the PATCH body", async () => {
    const { tool, calls } = partiesTool();
    await tool.handler({
      action: "set",
      args: {
        id: "pass4",
        role: "distributor",
        legalName: "Distributor Ltd",
        legacyOperatorId: "X123",
        operatorIdentifier: { scheme: "did", did: "did:web:example.com" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      operatorIdentifier: { scheme: "did", did: "did:web:example.com" },
    });
  });

  it("set forwards operatorIdentifier doi to the PATCH body", async () => {
    const { tool, calls } = partiesTool();
    await tool.handler({
      action: "set",
      args: {
        id: "pass5",
        role: "recycler",
        legalName: "DOI Corp",
        legacyOperatorId: "DOI-1",
        operatorIdentifier: { scheme: "doi", doi: "10.1234/example" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      operatorIdentifier: { scheme: "doi", doi: "10.1234/example" },
    });
  });

  it("set forwards facilityIdentifier gln with extension to the PATCH body", async () => {
    const { tool, calls } = partiesTool();
    await tool.handler({
      action: "set",
      args: {
        id: "pass6",
        role: "manufacturer",
        legalName: "Plant Corp",
        gln: "4012345678901",
        facilityIdentifier: { scheme: "gln", gln: "4012345678901", extension: "1" },
      },
    });
    expect(calls[0]!.body).toMatchObject({
      facilityIdentifier: { scheme: "gln", gln: "4012345678901", extension: "1" },
    });
  });

  it("operatorIdentifier with invalid ICD (not 4 digits) is rejected client-side", async () => {
    const { tool, calls } = partiesTool();
    const r = await tool.handler({
      action: "set",
      args: {
        id: "pass7",
        role: "manufacturer",
        legalName: "Acme",
        operatorIdentifier: { scheme: "iso6523", icd: "199", value: "abc" },
      },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("operatorIdentifier with invalid GLN (not 13 digits) is rejected client-side", async () => {
    const { tool, calls } = partiesTool();
    const r = await tool.handler({
      action: "set",
      args: {
        id: "pass8",
        role: "manufacturer",
        legalName: "Acme",
        operatorIdentifier: { scheme: "gln", gln: "12345" },
      },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("operatorIdentifier with invalid DID syntax is rejected client-side", async () => {
    const { tool, calls } = partiesTool();
    const r = await tool.handler({
      action: "set",
      args: {
        id: "pass9",
        role: "manufacturer",
        legalName: "Acme",
        operatorIdentifier: { scheme: "did", did: "not-a-did" },
      },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("operatorIdentifier with unknown scheme is rejected client-side", async () => {
    const { tool, calls } = partiesTool();
    const r = await tool.handler({
      action: "set",
      args: {
        id: "pass10",
        role: "manufacturer",
        legalName: "Acme",
        operatorIdentifier: { scheme: "rfid", code: "ABCDEF" },
      },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("operatorIdentifier did with uppercase method is rejected (W3C DID Core: method must be lowercase)", async () => {
    const { tool, calls } = partiesTool();
    const r = await tool.handler({
      action: "set",
      args: {
        id: "pass-did-upper",
        role: "manufacturer",
        legalName: "Acme",
        operatorIdentifier: { scheme: "did", did: "did:WEB:example.com" },
      },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("operatorIdentifier iso6523 value over 256 chars is rejected", async () => {
    const { tool, calls } = partiesTool();
    const r = await tool.handler({
      action: "set",
      args: {
        id: "pass-long",
        role: "manufacturer",
        legalName: "Acme",
        operatorIdentifier: { scheme: "iso6523", icd: "0199", value: "A".repeat(257) },
      },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("facilityIdentifier gln with empty string extension is rejected", async () => {
    const { tool, calls } = partiesTool();
    const r = await tool.handler({
      action: "set",
      args: {
        id: "pass-ext",
        role: "manufacturer",
        legalName: "Plant Corp",
        gln: "4012345678901",
        facilityIdentifier: { scheme: "gln", gln: "4012345678901", extension: "" },
      },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("operatorIdentifier doi accepts doi: and https://doi.org/ prefixes", async () => {
    const { tool, calls } = partiesTool();
    for (const doi of ["10.1234/x", "doi:10.1234/x", "https://doi.org/10.1234/x"]) {
      calls.length = 0;
      const r = await tool.handler({
        action: "set",
        args: {
          id: "pass11",
          role: "manufacturer",
          legalName: "DOI Corp",
          legacyOperatorId: "X",
          operatorIdentifier: { scheme: "doi", doi },
        },
      });
      expect(r.isError).toBeFalsy();
      expect(calls[0]!.body).toMatchObject({ operatorIdentifier: { doi } });
    }
  });

  it("remove routes to the party delete endpoint", async () => {
    const { tool, calls } = partiesTool();
    await tool.handler({ action: "remove", args: { id: "pass12", role: "recycler" } });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toBe("/api/v1/passports/pass12/parties/recycler");
  });
});

describe("tracepass_templates — regulatory schema routing", () => {
  function templatesTool() {
    const stub = stubClient();
    const tool = buildTools(stub.client).find((t) => t.name === "tracepass_templates")!;
    return { tool, calls: stub.calls };
  }

  it("list routes to GET /api/v1/templates", async () => {
    const { tool, calls } = templatesTool();
    await tool.handler({ action: "list", args: {} });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/templates");
  });

  it("get routes to GET /api/v1/templates/{category}", async () => {
    const { tool, calls } = templatesTool();
    await tool.handler({ action: "get", args: { category: "battery" } });
    expect(calls[0]!.path).toBe("/api/v1/templates/battery");
  });

  it("is marked read-only", () => {
    const { tool } = templatesTool();
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});

describe("tracepass_scope — scope-services actions", () => {
  function scopeTool() {
    const stub = stubClient();
    const tool = buildTools(stub.client).find((t) => t.name === "tracepass_scope")!;
    return { tool, calls: stub.calls };
  }

  // ── annotations ──
  it("is marked NOT read-only (catalogue_run writes results)", () => {
    const { tool } = scopeTool();
    expect(tool.annotations.readOnlyHint).toBe(false);
  });

  it("is marked NOT destructive (no action overwrites or removes existing data)", () => {
    const { tool } = scopeTool();
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it("is marked NOT open-world (only accesses the TracePass account)", () => {
    const { tool } = scopeTool();
    expect(tool.annotations.openWorldHint).toBe(false);
  });

  // ── check ──
  it("check POSTs to /api/v1/scope/check", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "check", args: { category: "battery" } });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/api/v1/scope/check");
  });

  it("check sends all provided fields in the body", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({
      action: "check",
      args: {
        category: "battery",
        facts: { "battery.use": "ev" },
        role: "importer",
        locale: "de",
      },
    });
    expect(calls[0]!.body).toMatchObject({
      category: "battery",
      facts: { "battery.use": "ev" },
      role: "importer",
      locale: "de",
    });
  });

  it("check with contains array sends it in the body", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({
      action: "check",
      args: {
        category: "toys",
        contains: [{ label: "battery", facts: { "battery.weightKg": 0.4 } }],
      },
    });
    expect(calls[0]!.body).toMatchObject({
      category: "toys",
      contains: [{ label: "battery", facts: { "battery.weightKg": 0.4 } }],
    });
  });

  it("check with placedOnMarket sends it in the body", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({
      action: "check",
      args: { category: "battery", placedOnMarket: { date: "2027-03", precision: "month" } },
    });
    expect(calls[0]!.body).toMatchObject({
      placedOnMarket: { date: "2027-03", precision: "month" },
    });
  });

  it("check with vehicles category sends it (vehicles is scope-only, not a template category)", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "check", args: { category: "vehicles" } });
    expect(calls[0]!.body).toMatchObject({ category: "vehicles" });
  });

  it("check with other category sends it", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "check", args: { category: "other" } });
    expect(calls[0]!.body).toMatchObject({ category: "other" });
  });

  it("check with a role too long returns isError without calling the API", async () => {
    const { tool, calls } = scopeTool();
    const r = await tool.handler({ action: "check", args: { role: "x".repeat(121) } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("check 429 scope_answer_cap is surfaced as a readable scope-specific message", async () => {
    const { client } = stubClient();
    // Override the stub to return a 429 scope_answer_cap
    const stubbedClient = {
      ...client,
      post: async () => ({
        status: 429,
        ok: false,
        body: { error: "scope_answer_cap", limit: 100, resetAt: "2026-10-12T00:00:00.000Z" },
      }),
    } as unknown as typeof client;
    const tool = buildTools(stubbedClient).find((t) => t.name === "tracepass_scope")!;
    const r = await tool.handler({ action: "check", args: { category: "battery" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Scope check.*limit/i);
    expect(r.content[0]!.text).toMatch(/100/);
    expect(r.content[0]!.text).toMatch(/2026-10-12/);
  });

  it("check 403 returns a readable plan message via apiResult", async () => {
    const { client } = stubClient();
    const stubbedClient = {
      ...client,
      post: async () => ({
        status: 403,
        ok: false,
        body: { error: "plan_upgrade_required", message: "This feature needs a higher plan." },
      }),
    } as unknown as typeof client;
    const tool = buildTools(stubbedClient).find((t) => t.name === "tracepass_scope")!;
    const r = await tool.handler({ action: "check", args: { category: "battery" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/plan/i);
    expect(r.content[0]!.text).toMatch(/do not retry/i);
  });

  // ── catalogue_report ──
  it("catalogue_report GETs /api/v1/scope/catalogue", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "catalogue_report", args: {} });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/scope/catalogue");
  });

  it("catalogue_report sends classification, category and limit as query params", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({
      action: "catalogue_report",
      args: { classification: "missing", category: "battery", limit: 50 },
    });
    expect(calls[0]!.path).toContain("classification=missing");
    expect(calls[0]!.path).toContain("category=battery");
    expect(calls[0]!.path).toContain("limit=50");
  });

  it("catalogue_report sends changed=true as a query param", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "catalogue_report", args: { changed: true } });
    expect(calls[0]!.path).toContain("changed=true");
  });

  it("catalogue_report changed=false omits the param", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "catalogue_report", args: { changed: false } });
    expect(calls[0]!.path).not.toContain("changed");
  });

  it("catalogue_report with an act (CELEX) filter sends it", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "catalogue_report", args: { act: "32023R1542" } });
    expect(calls[0]!.path).toContain("act=32023R1542");
  });

  it("catalogue_report 403 plan_upgrade_required is surfaced as a plan message", async () => {
    const { client } = stubClient();
    const stubbedClient = {
      ...client,
      get: async () => ({
        status: 403,
        ok: false,
        body: { error: "plan_upgrade_required", feature: "scopeCatalogueEnabled", message: "The catalogue scope check is available from the Growth plan." },
      }),
    } as unknown as typeof client;
    const tool = buildTools(stubbedClient).find((t) => t.name === "tracepass_scope")!;
    const r = await tool.handler({ action: "catalogue_report", args: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/plan_upgrade_required/);
    expect(r.content[0]!.text).toMatch(/Growth/);
    expect(r.content[0]!.text).toMatch(/do not retry/i);
  });

  it("catalogue_report limit over 500 returns isError without calling the API", async () => {
    const { tool, calls } = scopeTool();
    const r = await tool.handler({ action: "catalogue_report", args: { limit: 501 } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  // ── catalogue_run ──
  it("catalogue_run POSTs to /api/v1/scope/catalogue/runs", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "catalogue_run", args: {} });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/api/v1/scope/catalogue/runs");
  });

  it("catalogue_run with no args also works", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "catalogue_run" });
    expect(calls[0]!.path).toBe("/api/v1/scope/catalogue/runs");
  });

  // ── catalogue_run_status ──
  it("catalogue_run_status GETs /api/v1/scope/catalogue/runs/{id}", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "catalogue_run_status", args: { runId: "6650a1b2c3d4e5f6a7b8c9d0" } });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/scope/catalogue/runs/6650a1b2c3d4e5f6a7b8c9d0");
  });

  it("catalogue_run_status URL-encodes the runId", async () => {
    const { tool, calls } = scopeTool();
    await tool.handler({ action: "catalogue_run_status", args: { runId: "abc/def" } });
    expect(calls[0]!.path).toBe("/api/v1/scope/catalogue/runs/abc%2Fdef");
  });

  it("catalogue_run_status missing runId returns isError without calling the API", async () => {
    const { tool, calls } = scopeTool();
    const r = await tool.handler({ action: "catalogue_run_status", args: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid args/);
    expect(calls).toHaveLength(0);
  });

  // ── unknown action ──
  it("an unknown action returns isError", async () => {
    const { tool } = scopeTool();
    const r = await tool.handler({ action: "frobnicate", args: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Unknown action/);
  });
});
