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

  it("create builds the gs1 nested body", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: { productId: "p1", gtin: "09506000134369", serialNumber: "SN-1" },
    });
    expect(calls[0]!.body).toMatchObject({
      productId: "p1",
      gs1: { gtin: "09506000134369", serialNumber: "SN-1" },
    });
  });

  it("create forwards confirmOverage only when true", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({
      action: "create",
      args: { productId: "p1", gtin: "1", serialNumber: "s", confirmOverage: true },
    });
    expect(calls[0]!.body).toMatchObject({ confirmOverage: true });
  });

  it("archive routes to the archive endpoint", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "archive", args: { id: "x1" } });
    expect(calls[0]!.path).toBe("/api/v1/passports/x1/archive");
    expect(calls[0]!.method).toBe("POST");
  });

  it("get_by_serial URL-encodes the serial", async () => {
    const { tool, calls } = passportsTool();
    await tool.handler({ action: "get_by_serial", args: { serial: "LOT 1/A" } });
    expect(calls[0]!.path).toContain("LOT%201%2FA");
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
