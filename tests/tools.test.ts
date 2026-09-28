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
  it("exposes exactly 6 grouped tools", () => {
    const { client } = stubClient();
    const tools = buildTools(client);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "tracepass_epcis",
      "tracepass_passport_fields",
      "tracepass_passport_parties",
      "tracepass_passports",
      "tracepass_products",
      "tracepass_templates",
    ]);
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

describe("tracepass_passports — billable + lifecycle actions", () => {
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

  it("create forwards confirmOverage only when true", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: { productId: "p1", gtin: "1", serialNumber: "s", confirmOverage: true },
    });
    expect(calls[0]!.body).toMatchObject({ confirmOverage: true });
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
