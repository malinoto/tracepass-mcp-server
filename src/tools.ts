/**
 * MCP tool definitions for the TracePass v1 API.
 *
 * The v1 surface has ~23 endpoints. Exposing 23 flat MCP tools would
 * swamp the model's tool list and slow tool selection. Instead the
 * surface is grouped into FIVE resource tools, each taking:
 *   - `action` — a required enum naming the operation;
 *   - `args`   — an object whose required shape DEPENDS on `action`.
 *
 * MCP's `inputSchema` is one Zod shape per tool and can't natively
 * branch on `action`. So `args` is declared permissively, and each
 * handler validates `args` against the SPECIFIC per-action Zod
 * schema — the per-action rigor is kept, it just lives in the
 * handler. A model that omits a required arg gets a precise error
 * (`ACTION_SCHEMAS` powers both the validation and the messages).
 *
 * Every tool's `description` documents each action and its `args`.
 * `annotations` carry MCP hint flags at the tool level; per-action
 * risk (billable / irreversible) is spelled out in the description
 * so the model warns the user before a destructive action.
 *
 * Transport-agnostic: `buildTools(client)` binds the handlers to a
 * `TracePassClient`; the server factory registers them.
 */

import { z } from "zod";
import type { TracePassClient } from "./api-client.js";
import { apiResult, errorResult, type ToolResult } from "./result.js";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Encode a path segment (serials may contain spaces / slashes). */
const seg = (s: string) => encodeURIComponent(s);

/** Build a query string from defined values only. */
function qs(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Validate an action's `args` against its per-action schema.
 * Returns the parsed args, or an `errorResult` naming what's wrong —
 * which the handler returns straight to the model.
 */
function parseArgs<T extends z.ZodTypeAny>(
  schema: T,
  args: unknown,
  tool: string,
  action: string,
): z.infer<T> | ToolResult {
  const r = schema.safeParse(args ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return errorResult(
    `Invalid args for ${tool} action "${action}": ${issues}. ` +
      `Check the tool description for this action's required args.`,
  );
}
/** Type guard — did parseArgs return an error result? */
function isErr(v: unknown): v is ToolResult {
  return typeof v === "object" && v !== null && "content" in v;
}

// ── Per-action arg schemas ──────────────────────────────────────
// Reused by the handlers as validators. Kept here, one per action,
// so the per-action contract is explicit and testable.

const partyRoleEnum = z.enum([
  "manufacturer",
  "importer",
  "authorisedRepresentative",
  "distributor",
  "recycler",
  "producerResponsibilityOrg",
]);

const SCHEMAS = {
  productList: z.object({
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
    category: z.string().optional(),
    status: z.string().optional(),
    search: z.string().optional(),
  }),
  productGet: z.object({ id: z.string().min(1) }),
  productCreate: z.object({
    name: z.string().min(1).max(200),
    model: z.string().min(1).max(100),
    category: z.string().min(1),
    description: z.string().max(2000).optional(),
  }),
  productUpdate: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      model: z.string().min(1).max(100).optional(),
      description: z.string().max(2000).optional(),
    })
    .refine((v) => v.name || v.model || v.description !== undefined, {
      message: "pass at least one of name, model, description",
    }),

  passportList: z.object({
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
    productId: z.string().optional(),
    status: z.string().optional(),
    search: z.string().optional(),
  }),
  passportGet: z.object({
    id: z.string().min(1),
    format: z.enum(["summary", "full"]).optional(),
    lang: z.string().optional(),
  }),
  passportGetBySerial: z.object({
    serial: z.string().min(1),
    format: z.enum(["summary", "full"]).optional(),
    lang: z.string().optional(),
  }),
  passportCreate: z.object({
    productId: z.string().min(1),
    gtin: z.string().min(1),
    serialNumber: z.string().min(1).max(100),
    confirmOverage: z.boolean().optional(),
  }),
  passportId: z.object({ id: z.string().min(1) }),
  passportQr: z.object({
    id: z.string().min(1),
    format: z.enum(["svg", "png"]).optional(),
  }),

  fieldUpdate: z.object({
    id: z.string().min(1),
    fieldKey: z.string().min(1),
    value: z.unknown(),
  }),

  partySet: z.object({
    id: z.string().min(1),
    role: partyRoleEnum,
    legalName: z.string().min(1),
    gln: z.string().optional(),
    country: z.string().optional(),
    legacyOperatorId: z.string().optional(),
  }),
  partyRemove: z.object({ id: z.string().min(1), role: partyRoleEnum }),

  epcisExport: z.object({ id: z.string().min(1) }),
  epcisCapture: z.object({ events: z.unknown() }),
  epcisCaptureJob: z.object({ jobId: z.string().min(1) }),
  epcisQuery: z.object({ params: z.record(z.string(), z.string()).optional() }),
} as const;

/**
 * Build the 5 grouped tools, bound to a TracePass API client.
 */
export function buildTools(client: TracePassClient): McpToolDefinition[] {
  // ─────────────────────────── products ────────────────────────
  const productsTool: McpToolDefinition = {
    name: "tracepass_products",
    title: "TracePass products",
    description:
      "Manage the TracePass product catalogue. A product is the catalogue layer — one product can have many passports (one per serialised unit). Products are not billable on their own.\n\nActions (pass via `action`, with `args`):\n" +
      "- list — args: { page?, limit? (≤100), category?, status?, search? }. Read-only.\n" +
      "- get — args: { id }. Read-only.\n" +
      "- create — args: { name, model, category, description? }. `category` is one of: battery, textile, electronics, construction, steel, chemicals, packaging, furniture, tyres, jewelry, toys, fmcg.\n" +
      "- update — args: { id, name?, model?, description? }; pass at least one field to change.",
    inputSchema: {
      action: z.enum(["list", "get", "create", "update"]),
      args: z.record(z.string(), z.unknown()).optional()
        .describe("Action-specific arguments — see the description for each action's shape."),
    },
    annotations: { idempotentHint: false },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "list": {
          const p = parseArgs(SCHEMAS.productList, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/products${qs(p)}`));
        }
        case "get": {
          const p = parseArgs(SCHEMAS.productGet, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/products/${seg(p.id)}`));
        }
        case "create": {
          const p = parseArgs(SCHEMAS.productCreate, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          return apiResult(await client.post("/api/v1/products", p));
        }
        case "update": {
          const p = parseArgs(SCHEMAS.productUpdate, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          const { id, ...patch } = p;
          return apiResult(await client.patch(`/api/v1/products/${seg(id)}`, patch));
        }
        default:
          return errorResult(`Unknown action "${action}" for tracepass_products.`);
      }
    },
  };

  // ────────────────────────── passports ────────────────────────
  const passportsTool: McpToolDefinition = {
    name: "tracepass_passports",
    title: "TracePass passports",
    description:
      "Manage Digital Product Passports — create, read, and run lifecycle actions.\n\n" +
      "IMPORTANT: `create` consumes a DPP slot on the account's plan and IS BILLABLE. Creating a passport beyond the included quota incurs a per-passport overage charge; if over quota the tool returns a 402-style message — only re-run with args.confirmOverage=true after the user explicitly agrees to the charge. `archive` is IRREVERSIBLE (the public QR permanently 404s); prefer `suspend` when a change might be undone.\n\n" +
      "Actions (pass via `action`, with `args`):\n" +
      "- list — args: { page?, limit? (≤100), productId?, status?, search? }. status ∈ draft|in_review|approved|published|suspended|expired|archived. Read-only.\n" +
      "- get — args: { id, format? (summary|full), lang? }. Read-only.\n" +
      "- get_by_serial — args: { serial, format?, lang? }. Read-only.\n" +
      "- create — args: { productId, gtin, serialNumber, confirmOverage? }. BILLABLE.\n" +
      "- suspend — args: { id }. Reversible — public QR shows 'suspended'.\n" +
      "- archive — args: { id }. IRREVERSIBLE — confirm with the user first.\n" +
      "- get_qr — args: { id, format? (svg|png) }. Read-only.",
    inputSchema: {
      action: z.enum([
        "list",
        "get",
        "get_by_serial",
        "create",
        "suspend",
        "archive",
        "get_qr",
      ]),
      args: z.record(z.string(), z.unknown()).optional()
        .describe("Action-specific arguments — see the description for each action's shape."),
    },
    annotations: { idempotentHint: false },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "list": {
          const p = parseArgs(SCHEMAS.passportList, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/passports${qs(p)}`));
        }
        case "get": {
          const p = parseArgs(SCHEMAS.passportGet, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(`/api/v1/passports/${seg(p.id)}${qs({ format: p.format, lang: p.lang })}`),
          );
        }
        case "get_by_serial": {
          const p = parseArgs(SCHEMAS.passportGetBySerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(
              `/api/v1/passports/by-serial/${seg(p.serial)}${qs({ format: p.format, lang: p.lang })}`,
            ),
          );
        }
        case "create": {
          const p = parseArgs(SCHEMAS.passportCreate, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.post("/api/v1/passports", {
              productId: p.productId,
              gs1: { gtin: p.gtin, serialNumber: p.serialNumber },
              ...(p.confirmOverage ? { confirmOverage: true } : {}),
            }),
          );
        }
        case "suspend": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.post(`/api/v1/passports/${seg(p.id)}/suspend`));
        }
        case "archive": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.post(`/api/v1/passports/${seg(p.id)}/archive`));
        }
        case "get_qr": {
          const p = parseArgs(SCHEMAS.passportQr, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(`/api/v1/passports/${seg(p.id)}/qr${qs({ format: p.format })}`),
          );
        }
        default:
          return errorResult(`Unknown action "${action}" for tracepass_passports.`);
      }
    },
  };

  // ──────────────────────── passport fields ────────────────────
  const fieldsTool: McpToolDefinition = {
    name: "tracepass_passport_fields",
    title: "TracePass passport fields",
    description:
      "Update field values on a Digital Product Passport. Every change is recorded in the passport's audit trail, tagged as an API-key update.\n\n" +
      "Actions (pass via `action`, with `args`):\n" +
      "- update — args: { id, fieldKey, value }. `value` type matches the field's dataType (string, number, boolean, array, object).",
    inputSchema: {
      action: z.enum(["update"]),
      args: z.record(z.string(), z.unknown()).optional()
        .describe("Action-specific arguments — see the description."),
    },
    annotations: { idempotentHint: true },
    handler: async (a) => {
      const action = String(a.action);
      if (action !== "update") {
        return errorResult(`Unknown action "${action}" for tracepass_passport_fields.`);
      }
      const p = parseArgs(SCHEMAS.fieldUpdate, a.args, "tracepass_passport_fields", action);
      if (isErr(p)) return p;
      return apiResult(
        await client.patch(`/api/v1/passports/${seg(p.id)}/fields/${seg(p.fieldKey)}`, {
          value: p.value,
        }),
      );
    },
  };

  // ─────────────────────── passport parties ────────────────────
  const partiesTool: McpToolDefinition = {
    name: "tracepass_passport_parties",
    title: "TracePass passport parties",
    description:
      "Manage the economic-operator parties on a passport — manufacturer, importer, authorisedRepresentative, distributor, recycler, producerResponsibilityOrg. Each party carries a legal name and ideally a validated 13-digit GS1 GLN.\n\n" +
      "Actions (pass via `action`, with `args`):\n" +
      "- set — args: { id, role, legalName, gln?, country?, legacyOperatorId? }. Sets or updates one role.\n" +
      "- remove — args: { id, role }. Clears one role.",
    inputSchema: {
      action: z.enum(["set", "remove"]),
      args: z.record(z.string(), z.unknown()).optional()
        .describe("Action-specific arguments — see the description."),
    },
    annotations: { idempotentHint: true },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "set": {
          const p = parseArgs(SCHEMAS.partySet, a.args, "tracepass_passport_parties", action);
          if (isErr(p)) return p;
          const { id, role, ...party } = p;
          return apiResult(
            await client.patch(`/api/v1/passports/${seg(id)}/parties/${seg(role)}`, party),
          );
        }
        case "remove": {
          const p = parseArgs(SCHEMAS.partyRemove, a.args, "tracepass_passport_parties", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.delete(`/api/v1/passports/${seg(p.id)}/parties/${seg(p.role)}`),
          );
        }
        default:
          return errorResult(`Unknown action "${action}" for tracepass_passport_parties.`);
      }
    },
  };

  // ───────────────────────────── epcis ─────────────────────────
  const epcisTool: McpToolDefinition = {
    name: "tracepass_epcis",
    title: "TracePass EPCIS 2.0",
    description:
      "GS1 EPCIS 2.0 supply-chain events. `export` is included on Starter plans and up; `capture`, `capture_job`, and `query` require the paid EPCIS add-on (those actions return a 403-style message without it).\n\n" +
      "Actions (pass via `action`, with `args`):\n" +
      "- export — args: { id }. Export a passport's events as an EPCIS 2.0 JSON-LD document. Read-only.\n" +
      "- capture — args: { events }. `events` is an EPCISDocument, a single event, or an array of events (JSON-LD). Returns a 202 with a captureJobId.\n" +
      "- capture_job — args: { jobId }. Poll an async capture job. Read-only.\n" +
      "- query — args: { params? }. `params` is a key/value map of standard EPCIS query parameters (EQ_bizStep, GE_eventTime, MATCH_epc, …). Read-only.",
    inputSchema: {
      action: z.enum(["export", "capture", "capture_job", "query"]),
      args: z.record(z.string(), z.unknown()).optional()
        .describe("Action-specific arguments — see the description."),
    },
    annotations: { idempotentHint: false },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "export": {
          const p = parseArgs(SCHEMAS.epcisExport, a.args, "tracepass_epcis", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/passports/${seg(p.id)}/epcis`));
        }
        case "capture": {
          const p = parseArgs(SCHEMAS.epcisCapture, a.args, "tracepass_epcis", action);
          if (isErr(p)) return p;
          return apiResult(await client.post("/api/v1/epcis/capture", p.events));
        }
        case "capture_job": {
          const p = parseArgs(SCHEMAS.epcisCaptureJob, a.args, "tracepass_epcis", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/epcis/capture/${seg(p.jobId)}`));
        }
        case "query": {
          const p = parseArgs(SCHEMAS.epcisQuery, a.args, "tracepass_epcis", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(`/api/v1/epcis/events${qs(p.params ?? {})}`),
          );
        }
        default:
          return errorResult(`Unknown action "${action}" for tracepass_epcis.`);
      }
    },
  };

  return [productsTool, passportsTool, fieldsTool, partiesTool, epcisTool];
}
