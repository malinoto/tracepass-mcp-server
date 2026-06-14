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
  /** Declared shape of the tool's structured result, so MCP clients (and
   *  catalogues like Smithery) can validate + display the output. The tools
   *  pass v1 API JSON straight through, so this describes that envelope. */
  outputSchema: z.ZodRawShape;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Encode a path segment (serials may contain spaces / slashes). */
const seg = (s: string) => encodeURIComponent(s);

/**
 * Output schema shared by every tool. The tools pass the v1 API JSON straight
 * through, and the shape varies by action (a paginated list, a single entity, a
 * compliance verdict, an EPCIS document, a `{ result: "<qr svg>" }` wrapper for
 * non-object bodies, …). So the schema is an OPEN object: it documents the
 * fields a caller commonly sees, but `.passthrough()` lets the action-specific
 * fields through, so a valid call is never rejected by output validation. (The
 * MCP SDK skips this validation for `isError` results, so error envelopes — 402
 * overage, 403 plan-gate, 404, etc. — are unaffected.)
 *
 * Returned as a ZodRawShape (registerTool wraps it in z.object internally), with
 * the passthrough applied via `.catchall`.
 */
const apiOutputShape = {
  // Single-entity reads/writes (product, passport) return the entity object;
  // these are the fields most responses carry.
  id: z.string().optional().describe("The resource's TracePass id, when the response is a single entity."),
  // List reads return a paginated envelope.
  items: z.array(z.unknown()).optional().describe("The page of results, when the action is a list."),
  total: z.number().optional().describe("Total matching records across all pages (list actions)."),
  page: z.number().optional().describe("Current page number (list actions)."),
  limit: z.number().optional().describe("Page size (list actions)."),
  totalPages: z.number().optional().describe("Total number of pages (list actions)."),
  // Non-object bodies (e.g. a QR SVG/PNG string) are wrapped as { result: … }.
  result: z.unknown().optional().describe("Wraps a non-object response body (e.g. a QR code string)."),
  // Error envelope (also returned as isError text, but a structured copy may ride along).
  error: z.string().optional().describe("Machine-readable error code, when the API rejected the request."),
  message: z.string().optional().describe("Human-readable error or status detail, when present."),
} as const;

/** A ZodRawShape that validates the open API envelope without rejecting
 *  action-specific fields. (Spread into each tool's `outputSchema`.) */
const API_OUTPUT_SCHEMA: z.ZodRawShape = apiOutputShape;

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
  // By-serial addressing. `gtin` is the optional disambiguator: a serial is
  // unique only WITHIN a GTIN, so if the same serial exists under two GTINs in
  // the account, a serial-only call returns 409 ambiguous_serial — pass `gtin`
  // (or use the by-id action) to resolve exactly.
  passportSerial: z.object({
    serial: z.string().min(1),
    gtin: z.string().optional(),
  }),
  passportQr: z.object({
    id: z.string().min(1),
    format: z.enum(["svg", "png"]).optional(),
  }),

  fieldUpdate: z.object({
    id: z.string().min(1),
    fieldKey: z.string().min(1),
    value: z.unknown(),
  }),
  fieldUpdateBySerial: z.object({
    serial: z.string().min(1),
    fieldKey: z.string().min(1),
    value: z.unknown(),
    gtin: z.string().optional(),
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
  epcisExportBySerial: z.object({
    serial: z.string().min(1),
    gtin: z.string().optional(),
  }),
  epcisCapture: z.object({ events: z.unknown() }),
  epcisCaptureJob: z.object({ jobId: z.string().min(1) }),
  epcisQuery: z.object({ params: z.record(z.string(), z.string()).optional() }),

  templatesList: z.object({}),
  templateGet: z.object({ category: z.string().min(1) }),
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
      action: z
        .enum(["list", "get", "create", "update"])
        .describe("Which product operation to run: list | get | create | update."),
      args: z
        .object({
          id: z.string().optional().describe("Product id. Required for get and update."),
          name: z.string().optional().describe("Product name. Required for create; optional on update."),
          model: z.string().optional().describe("Manufacturer model / SKU. Required for create; optional on update."),
          category: z.string().optional().describe("DPP category for create: battery | textile | electronics | construction | steel | chemicals | packaging | furniture | tyres | jewelry | toys | fmcg."),
          description: z.string().optional().describe("Free-text product description (create/update)."),
          page: z.number().optional().describe("Page number for list (1-based)."),
          limit: z.number().optional().describe("Page size for list, max 100."),
          status: z.string().optional().describe("Filter list by product status."),
          search: z.string().optional().describe("Filter list by a search term."),
        })
        .partial()
        .optional()
        .describe("Arguments for the chosen action; required fields depend on `action` (see each action above)."),
    },
    outputSchema: API_OUTPUT_SCHEMA,
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
      "- get_by_serial — args: { serial, format?, lang?, gtin? }. Read-only. Addresses the passport by your own serial. A serial is unique only WITHIN a GTIN — if the same serial exists under two GTINs in your account the call returns 409 ambiguous_serial; pass `gtin` (or use the by-id action) to resolve exactly.\n" +
      "- compliance — args: { id }. Read-only. Returns a three-tier compliance verdict (compliant | compliant_with_warnings | incomplete) with regulation-cited findings — use to gap-check a passport against the rules for its category, fix the cited fields/parties, then re-check.\n" +
      "- create — args: { productId, gtin, serialNumber, confirmOverage? }. BILLABLE.\n" +
      "- suspend — args: { id }. Reversible — public QR shows 'suspended'.\n" +
      "- suspend_by_serial — args: { serial, gtin? }. Same as suspend, addressed by your serial. 409 ambiguous_serial if the serial isn't unique in your account — pass `gtin`.\n" +
      "- archive — args: { id }. IRREVERSIBLE — confirm with the user first.\n" +
      "- archive_by_serial — args: { serial, gtin? }. IRREVERSIBLE, addressed by your serial — confirm first. 409 ambiguous_serial if the serial isn't unique — pass `gtin`.\n" +
      "- get_qr — args: { id, format? (svg|png) }. Read-only.",
    inputSchema: {
      action: z
        .enum([
          "list",
          "get",
          "get_by_serial",
          "compliance",
          "create",
          "suspend",
          "suspend_by_serial",
          "archive",
          "archive_by_serial",
          "get_qr",
        ])
        .describe(
          "Which passport operation to run. Reads: list | get | get_by_serial | compliance | get_qr. Lifecycle: create (BILLABLE) | suspend (reversible) | archive (IRREVERSIBLE), each with a _by_serial variant.",
        ),
      args: z
        .object({
          id: z.string().optional().describe("Passport id. Required for get/compliance/create-result/suspend/archive/get_qr (the by-id actions)."),
          serial: z.string().optional().describe("Your own serial number. Required for the *_by_serial actions."),
          gtin: z.string().optional().describe("GTIN disambiguator for *_by_serial actions when a serial isn't unique across GTINs (else 409 ambiguous_serial)."),
          productId: z.string().optional().describe("Parent product id. Required for create."),
          serialNumber: z.string().optional().describe("Serial for the new passport. Required for create."),
          confirmOverage: z.boolean().optional().describe("Set true to accept a per-passport overage charge when create is over the plan quota (402)."),
          format: z.string().optional().describe("get/get_by_serial: summary|full. get_qr: svg|png."),
          lang: z.string().optional().describe("Resolve field values to one of the 24 EU locales server-side (get/get_by_serial)."),
          page: z.number().optional().describe("Page number for list (1-based)."),
          limit: z.number().optional().describe("Page size for list, max 100."),
          status: z.string().optional().describe("Filter list by status: draft|in_review|approved|published|suspended|expired|archived."),
          search: z.string().optional().describe("Filter list by a search term."),
        })
        .partial()
        .optional()
        .describe("Arguments for the chosen action; required fields depend on `action` (see each action above)."),
    },
    outputSchema: API_OUTPUT_SCHEMA,
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
        case "compliance": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/passports/${seg(p.id)}/compliance`));
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
        case "suspend_by_serial": {
          const p = parseArgs(SCHEMAS.passportSerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.post(`/api/v1/passports/by-serial/${seg(p.serial)}/suspend${qs({ gtin: p.gtin })}`),
          );
        }
        case "archive": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.post(`/api/v1/passports/${seg(p.id)}/archive`));
        }
        case "archive_by_serial": {
          const p = parseArgs(SCHEMAS.passportSerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.post(`/api/v1/passports/by-serial/${seg(p.serial)}/archive${qs({ gtin: p.gtin })}`),
          );
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
      "- update — args: { id, fieldKey, value }. `value` type matches the field's dataType (string, number, boolean, array, object).\n" +
      "- update_by_serial — args: { serial, fieldKey, value, gtin? }. Same as update, addressed by your own serial. A serial is unique only WITHIN a GTIN — if it isn't unique in your account the call returns 409 ambiguous_serial; pass `gtin` (or use update by id) to resolve exactly.",
    inputSchema: {
      action: z
        .enum(["update", "update_by_serial"])
        .describe("Update one passport field, addressed by passport id (update) or by your serial (update_by_serial)."),
      args: z
        .object({
          id: z.string().optional().describe("Passport id. Required for update."),
          serial: z.string().optional().describe("Your serial. Required for update_by_serial."),
          gtin: z.string().optional().describe("GTIN disambiguator for update_by_serial when the serial isn't unique (else 409)."),
          fieldKey: z.string().optional().describe("The field key to set (required)."),
          value: z.unknown().optional().describe("The new value for the field (required). Type depends on the field's dataType."),
        })
        .partial()
        .optional()
        .describe("Arguments for the chosen action; required fields depend on `action`."),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: { idempotentHint: true },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "update": {
          const p = parseArgs(SCHEMAS.fieldUpdate, a.args, "tracepass_passport_fields", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.patch(`/api/v1/passports/${seg(p.id)}/fields/${seg(p.fieldKey)}`, {
              value: p.value,
            }),
          );
        }
        case "update_by_serial": {
          const p = parseArgs(SCHEMAS.fieldUpdateBySerial, a.args, "tracepass_passport_fields", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.patch(
              `/api/v1/passports/by-serial/${seg(p.serial)}/fields/${seg(p.fieldKey)}${qs({ gtin: p.gtin })}`,
              { value: p.value },
            ),
          );
        }
        default:
          return errorResult(`Unknown action "${action}" for tracepass_passport_fields.`);
      }
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
      action: z
        .enum(["set", "remove"])
        .describe("Set (add/replace) or remove an economic-operator party on a passport by its role."),
      args: z
        .object({
          id: z.string().optional().describe("Passport id (required)."),
          role: z.string().optional().describe("Economic-operator role, e.g. manufacturer | importer | distributor | authorised_representative (required)."),
          legalName: z.string().optional().describe("Party legal name. Required for set."),
          gln: z.string().optional().describe("GS1 Global Location Number for the party (set, optional)."),
          country: z.string().optional().describe("Party country code (set, optional)."),
          legacyOperatorId: z.string().optional().describe("Your internal operator id for the party (set, optional)."),
        })
        .partial()
        .optional()
        .describe("Arguments for the chosen action; required fields depend on `action`."),
    },
    outputSchema: API_OUTPUT_SCHEMA,
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
      "- export_by_serial — args: { serial, gtin? }. Same as export, addressed by your own serial. A serial is unique only WITHIN a GTIN — if it isn't unique in your account the call returns 409 ambiguous_serial; pass `gtin` (or use export by id). Read-only.\n" +
      "- capture — args: { events }. `events` is an EPCISDocument, a single event, or an array of events (JSON-LD). Returns a 202 with a captureJobId.\n" +
      "- capture_job — args: { jobId }. Poll an async capture job. Read-only.\n" +
      "- query — args: { params? }. `params` is a key/value map of standard EPCIS query parameters (EQ_bizStep, GE_eventTime, MATCH_epc, …). Read-only.",
    inputSchema: {
      action: z
        .enum(["export", "export_by_serial", "capture", "capture_job", "query"])
        .describe("EPCIS 2.0: export a passport's events (export | export_by_serial), capture new events, poll a capture job, or query events."),
      args: z
        .object({
          id: z.string().optional().describe("Passport id. Required for export."),
          serial: z.string().optional().describe("Your serial. Required for export_by_serial."),
          gtin: z.string().optional().describe("GTIN disambiguator for export_by_serial when the serial isn't unique (else 409)."),
          events: z.unknown().optional().describe("EPCIS 2.0 event payload (an EPCISDocument or event list). Required for capture."),
          jobId: z.string().optional().describe("Capture job id to poll. Required for capture_job."),
          params: z.record(z.string(), z.string()).optional().describe("EPCIS query parameters as key→value strings (query, optional)."),
        })
        .partial()
        .optional()
        .describe("Arguments for the chosen action; required fields depend on `action`."),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: { idempotentHint: false },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "export": {
          const p = parseArgs(SCHEMAS.epcisExport, a.args, "tracepass_epcis", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/passports/${seg(p.id)}/epcis`));
        }
        case "export_by_serial": {
          const p = parseArgs(SCHEMAS.epcisExportBySerial, a.args, "tracepass_epcis", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(`/api/v1/passports/by-serial/${seg(p.serial)}/epcis${qs({ gtin: p.gtin })}`),
          );
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

  // ─────────────────────────── templates ───────────────────────
  // The regulatory schema layer: WHAT a compliant DPP in each category
  // must contain. This is what turns the assistant from a CRUD client
  // into a compliance copilot — it can tell a user which fields a
  // battery / textile / … passport needs, and cite the regulation,
  // BEFORE any product or passport exists.
  const templatesTool: McpToolDefinition = {
    name: "tracepass_templates",
    title: "TracePass DPP templates (regulatory schemas)",
    description:
      "Discover the regulatory field schema for each DPP category — what a COMPLIANT passport must contain, per the governing EU regulation. Read-only reference data. Use this to advise on requirements before creating products/passports, and to gap-check a draft against the rules.\n\nActions (pass via `action`, with `args`):\n" +
      "- list — args: {}. Lists all 12 categories with their field count, required-field count, and governing regulation (name + number + effective/mandatory dates).\n" +
      "- get — args: { category }. Full field schema for one category: every field's key, label, dataType, whether it is REQUIRED, its access level (public/restricted/authority), enum options, validation bounds, and — where known — the regulation article/annex that mandates it. `category` is one of: battery, textile, electronics, construction, steel, chemicals, packaging, furniture, tyres, jewelry, toys, fmcg.",
    inputSchema: {
      action: z
        .enum(["list", "get"])
        .describe("List all DPP category templates, or get one template by category."),
      args: z
        .object({
          category: z.string().optional().describe("DPP category to fetch (required for get): battery | textile | electronics | construction | steel | chemicals | packaging | furniture | tyres | jewelry | toys | fmcg."),
        })
        .partial()
        .optional()
        .describe("Arguments for the chosen action; `category` is required for get, ignored for list."),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: { idempotentHint: true, readOnlyHint: true },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "list": {
          parseArgs(SCHEMAS.templatesList, a.args ?? {}, "tracepass_templates", action);
          return apiResult(await client.get("/api/v1/templates"));
        }
        case "get": {
          const p = parseArgs(SCHEMAS.templateGet, a.args, "tracepass_templates", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/templates/${seg(p.category)}`));
        }
        default:
          return errorResult(`Unknown action "${action}" for tracepass_templates.`);
      }
    },
  };

  return [productsTool, passportsTool, fieldsTool, partiesTool, epcisTool, templatesTool];
}
