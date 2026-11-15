/**
 * The main server's `tools/list` response is read into the model's context on every
 * conversation, so its size is a contract: an outside scanner flagged it as excessive
 * at 57 KB. These tests build the list the way a client receives it (a real MCP client
 * over an in-memory transport) and hold three things:
 *
 *   - the size stays under a budget (`npm run measure:tools` prints the breakdown);
 *   - the part clients and the n8n node depend on (names, titles, annotations, action
 *     enums, argument keys, required fields, types) is exactly the committed contract;
 *   - what moved out of the descriptions is still reachable, and what must stay in them
 *     (the safety guidance) still does.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/server.js";
import { REFERENCE_DOCS } from "../src/reference.js";
import { named } from "./helpers.js";

/** Upper bound for the serialised `tools/list` result, in bytes. Was 56348 before the cut. */
const BUDGET_BYTES = 28_000;

async function connect(): Promise<Client> {
  const server = createMcpServer({ baseUrl: "https://example.invalid", apiKey: "tp_test" });
  const client = new Client({ name: "size-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function listTools(): Promise<Tool[]> {
  const client = await connect();
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

function stripDescriptions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDescriptions);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k, x]) => !(k === "description" && typeof x === "string"))
        .map(([k, x]) => [k, stripDescriptions(x)]),
    );
  }
  return v;
}

describe("tools/list size", () => {
  it("the serialised list stays under the budget", async () => {
    const tools = await listTools();
    const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
    expect(bytes).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("only descriptions changed: names, annotations and schemas match the committed contract", async () => {
    const tools = await listTools();
    const actual = JSON.parse(
      JSON.stringify(
        tools.map((t) => ({
          ...t,
          description: undefined,
          inputSchema: stripDescriptions(t.inputSchema),
          outputSchema: stripDescriptions(t.outputSchema),
        })),
      ),
    ) as unknown;
    const expected = JSON.parse(
      readFileSync(new URL("./fixtures/tools-contract.json", import.meta.url), "utf8"),
    ) as unknown;
    // Regenerate with `npm run measure:tools -- --contract > tests/fixtures/tools-contract.json`
    // only for a deliberate schema change.
    expect(actual).toEqual(expected);
  });
});

describe("reference resources behind the tool descriptions", () => {
  it("every tracepass://reference/<slug> a description points at is registered and readable", async () => {
    const tools = await listTools();
    const mentioned = new Set(
      tools.flatMap((t) =>
        [...(t.description ?? "").matchAll(/tracepass:\/\/reference\/([a-z]+)/g)].map(
          (m) => m[1] ?? "",
        ),
      ),
    );
    expect(mentioned.size).toBeGreaterThan(0);

    const client = await connect();
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri);
      for (const slug of mentioned) {
        expect(uris).toContain(`tracepass://reference/${slug}`);
        const read = await client.readResource({ uri: `tracepass://reference/${slug}` });
        const first = read.contents[0];
        expect(first && "text" in first ? first.text.length : 0).toBeGreaterThan(200);
      }
      // Nothing registered that no description points at.
      for (const doc of REFERENCE_DOCS) expect(mentioned).toContain(doc.slug);
    } finally {
      await client.close();
    }
  });

  it("the moved detail is in the reference text", () => {
    const text = (slug: string) => REFERENCE_DOCS.find((d) => d.slug === slug)?.text ?? "";
    expect(text("passports")).toMatch(/iec61406 — \{ scheme:"iec61406"/);
    expect(text("passports")).toMatch(/registry_not_ready/);
    expect(text("passports")).toMatch(/field_not_applicable/);
    expect(text("lifecycle")).toMatch(/registry_host_not_allowed/);
    expect(text("lifecycle")).toMatch(/reason_contradicts_placement/);
    expect(text("scope")).toMatch(/scope_answer_cap/);
    expect(text("parties")).toMatch(/iso6523/);
    expect(text("templates")).toMatch(/MUTUALLY EXCLUSIVE/);
  });
});

describe("safety guidance stays in the descriptions", () => {
  it("lifecycle: irreversible archive, suspend as the reversible alternative, confirm first", async () => {
    const d = named(await listTools(), "tracepass_passport_lifecycle").description ?? "";
    expect(d).toMatch(/^WARNING:/);
    expect(d).toMatch(/`archive` permanently removes the public QR code \(it 404s forever\)/);
    expect(d).toMatch(/MUST confirm with the user before each call/);
    expect(d).toMatch(/`suspend` \(reversible/);
    expect(d).toMatch(/cannot be suspended/);
    expect(d).toMatch(/IRREVERSIBLE and destructive/);
    expect(d).toMatch(/reason is REQUIRED for battery passports/);
    expect(d).toMatch(/archive_product[^\n]*PRODUCT/);
  });

  it("passports: create is a draft, set_condition_flags warns about blocking publish, registry is the operator's act", async () => {
    const d = named(await listTools(), "tracepass_passports").description ?? "";
    expect(d).toMatch(/DRAFT passport/);
    expect(d).toMatch(/WARNING: approving a flag can make fields required and block publishing/);
    expect(d).toMatch(/never submits to the Registry and never verifies/);
    expect(d).toMatch(/ONLY gs1 and iso15459/);
  });

  it("scope: the hard rules and the plan-gate instruction stay", async () => {
    const d = named(await listTools(), "tracepass_scope").description ?? "";
    expect(d).toMatch(/HARD RULES/);
    expect(d).toMatch(/never write 'you must'/);
    expect(d).toMatch(/NEVER a deadline/);
    expect(d).toMatch(/Planned, not law yet/);
    expect(d).toMatch(/needs_recheck/);
    expect(d).toMatch(/plan_upgrade_required[^\n]*do not retry/);
  });

  it("templates: battery scope comes before required", async () => {
    const d = named(await listTools(), "tracepass_templates").description ?? "";
    expect(d).toMatch(/SCOPE FIRST/);
    expect(d).toMatch(/industrial_lte_2kwh/);
    expect(d).toMatch(/requiredBy/);
  });

  it("fields: ai_suggested goes to human review", async () => {
    const d = named(await listTools(), "tracepass_passport_fields").description ?? "";
    expect(d).toMatch(/ai_suggested/);
    expect(d).toMatch(/review queue for a human/);
  });

  it("products: create_batch is all-or-nothing against the daily cap", async () => {
    const d = named(await listTools(), "tracepass_products").description ?? "";
    expect(d).toMatch(/NOTHING is created \(429\)/);
  });
});
