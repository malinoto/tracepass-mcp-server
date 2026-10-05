/**
 * MCP tool definitions for the TracePass v1 API.
 *
 * The v1 surface has ~23 endpoints. Exposing 23 flat MCP tools would
 * swamp the model's tool list and slow tool selection. Instead the
 * surface is grouped into SIX resource tools, each taking:
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

/**
 * EN 18219 product-identifier discriminated union.
 * Mirrors the `ProductIdentifier` schema in the OpenAPI spec.
 * Battery passports accept only gs1 and iso15459 (Art. 77(3)).
 */
const productIdentifierSchema = z.discriminatedUnion("scheme", [
  z.object({
    scheme: z.literal("gs1"),
    gtin: z.string().min(1),
    serialNumber: z.string().min(1).max(100),
  }),
  z.object({
    scheme: z.literal("iso15459"),
    issuingAgencyCode: z.string().min(1).max(3),
    primaryId: z.string().min(1),
    serial: z.string().optional(),
    raw: z.string().min(1).optional(),
  }),
  z.object({
    scheme: z.literal("iec61406"),
    uri: z.string().url(),
  }),
  z.object({
    scheme: z.literal("did"),
    did: z.string().min(1),
    method: z.string().min(1),
  }),
  z.object({
    scheme: z.literal("doi"),
    // Bare 10.x, or with a doi: / https://doi.org/ / dx.doi.org prefix, which
    // the platform strips (it accepts the same forms).
    doi: z.string().regex(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?10\./i),
    // EN 18219 §5.6.2(b): a DOI product identifier must declare whether it
    // identifies the product model, a production batch, or an individual item.
    granularity: z.enum(["model", "batch", "item"]),
  }),
]);

const partyRoleEnum = z.enum([
  "manufacturer",
  "importer",
  "authorisedRepresentative",
  "distributor",
  "recycler",
  "producerResponsibilityOrg",
]);

/**
 * EN 18219 §6.2–6.5 operator-identifier discriminated union.
 * Four schemes: iso6523 (LEI/GLN/DUNS), gln, did, doi.
 * Passed through to the PATCH body without transformation — the platform
 * enforces the cross-field rules (gln+operatorIdentifier match, etc.).
 */
const operatorIdentifierSchema = z.discriminatedUnion("scheme", [
  z.object({
    scheme: z.literal("iso6523"),
    icd: z.string().regex(/^\d{4}$/, "ICD must be exactly 4 digits (ISO/IEC 6523)"),
    value: z.string().min(1).max(256),
  }),
  z.object({
    scheme: z.literal("gln"),
    gln: z.string().regex(/^\d{13}$/, "GLN must be exactly 13 digits"),
  }),
  z.object({
    scheme: z.literal("did"),
    // EN 18219 §6.4.2(b): syntax check only; verification requires an authorised-register VC.
    // W3C DID Core: method MUST be lowercase alphanumerics only.
    did: z.string().regex(/^did:[a-z0-9]+:.+/, "DID must match did:<method>:<id> with lowercase alphanumeric method").max(512),
  }),
  z.object({
    scheme: z.literal("doi"),
    doi: z.string().regex(
      /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i,
      "DOI must be a valid 10.<4-9 digits>/<suffix> (bare or with doi:/URL prefix)",
    ).max(512),
  }),
]);

/**
 * EN 18219 §6.2–6.5 facility-identifier discriminated union.
 * Same four schemes as operatorIdentifierSchema, but the gln variant
 * also accepts an optional GS1 SGLN sub-location `extension`.
 * facilityIdentifier never fills the top-level `gln` field.
 */
const facilityIdentifierSchema = z.discriminatedUnion("scheme", [
  z.object({
    scheme: z.literal("iso6523"),
    icd: z.string().regex(/^\d{4}$/, "ICD must be exactly 4 digits (ISO/IEC 6523)"),
    value: z.string().min(1).max(256),
  }),
  z.object({
    scheme: z.literal("gln"),
    gln: z.string().regex(/^\d{13}$/, "GLN must be exactly 13 digits"),
    // GS1 SGLN sub-location extension — non-empty when present, max 80 chars.
    extension: z.string().min(1).max(80).optional(),
  }),
  z.object({
    scheme: z.literal("did"),
    did: z.string().regex(/^did:[a-z0-9]+:.+/, "DID must match did:<method>:<id> with lowercase alphanumeric method").max(512),
  }),
  z.object({
    scheme: z.literal("doi"),
    doi: z.string().regex(
      /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i,
      "DOI must be a valid 10.<4-9 digits>/<suffix> (bare or with doi:/URL prefix)",
    ).max(512),
  }),
]);

// Battery second-life lineage (Art. 77(7) of Reg (EU) 2023/1542). Mirrors the
// platform's lineageInputSchema; the platform enforces the business rules (422).
const lineageSchema = z.object({
  predecessors: z
    .array(
      z
        .object({
          identifier: z.string().max(2000).optional(),
          internalPassportId: z.string().optional(),
          trigger: z.enum(["preparation_for_reuse", "preparation_for_repurposing", "repurposing", "remanufacturing"]),
        })
        .refine((p) => p.identifier !== undefined || p.internalPassportId !== undefined, {
          message: "each predecessor needs identifier or internalPassportId",
        }),
    )
    .max(10),
  noPredecessorReason: z.string().max(500).optional(),
});

// One battery measurement (Annex XIII point 4 use data) pushed from the
// customer's own equipment. The platform validates the key, type and range.
const measurementSchema = z.object({
  fieldKey: z.string().min(1),
  value: z.unknown(),
  measuredAt: z.string().min(1),
  externalId: z.string().optional(),
  unit: z.string().optional(),
});

/** Origin a caller may declare on a field write. Omitted → the API default,
 *  `manual` (the caller's own statement). `ai_suggested` sends the value to the
 *  dashboard review queue instead of approving it — for values the agent found
 *  itself rather than was told. The platform refuses other origins from API
 *  callers, so only these two are offered. */
const FIELD_SOURCE = z.enum(["manual", "ai_suggested"]);

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
  productArchive: z.object({ id: z.string().min(1) }),
  productCreateBatch: z.object({
    // The platform caps a batch at 100 and rejects the WHOLE request with 429
    // if it would exceed the daily write cap — so validating the length here
    // turns a wasted round-trip into an immediate, explainable error.
    products: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          model: z.string().min(1).max(100),
          category: z.string().min(1),
          description: z.string().max(2000).optional(),
        }),
      )
      .min(1)
      .max(100),
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
  passportCreate: z
    .object({
      productId: z.string().min(1),
      // EN 18219 scheme-tagged identifier (preferred on new integrations).
      identifier: productIdentifierSchema.optional(),
      // Legacy GS1 flat fields — accepted as a deprecated alias for
      // identifier with scheme:"gs1". One of identifier or gtin+serialNumber
      // must be present.
      gtin: z.string().optional(),
      serialNumber: z.string().min(1).max(100).optional(),
      confirmOverage: z.boolean().optional(),
      lineage: lineageSchema.optional(),
    })
    .refine(
      (v) =>
        v.identifier !== undefined ||
        (v.gtin !== undefined && v.serialNumber !== undefined),
      {
        message:
          "provide either identifier (with scheme) or the legacy gtin + serialNumber",
      },
    ),
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
    symbology: z.enum(["qr", "datamatrix"]).optional(),
  }),
  passportQrBySerial: z.object({
    serial: z.string().min(1),
    format: z.enum(["svg", "png"]).optional(),
    symbology: z.enum(["qr", "datamatrix"]).optional(),
    gtin: z.string().optional(),
  }),

  fieldUpdate: z.object({
    id: z.string().min(1),
    fieldKey: z.string().min(1),
    value: z.unknown(),
    source: FIELD_SOURCE.optional(),
  }),
  fieldUpdateBySerial: z.object({
    serial: z.string().min(1),
    fieldKey: z.string().min(1),
    value: z.unknown(),
    gtin: z.string().optional(),
    source: FIELD_SOURCE.optional(),
  }),

  partySet: z.object({
    id: z.string().min(1),
    role: partyRoleEnum,
    legalName: z.string().min(1),
    gln: z.string().optional(),
    country: z.string().optional(),
    legacyOperatorId: z.string().optional(),
    operatorIdentifier: operatorIdentifierSchema.optional(),
    facilityIdentifier: facilityIdentifierSchema.optional(),
  }),
  partyRemove: z.object({ id: z.string().min(1), role: partyRoleEnum }),

  snapshotList: z.object({
    id: z.string().min(1),
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
    at: z.string().min(1).optional(),
  }),
  snapshotGet: z.object({
    id: z.string().min(1),
    snapshotId: z.string().min(1),
  }),

  conditionFlagsGet: z.object({ id: z.string().min(1) }),
  conditionFlagsGetBySerial: z.object({
    serial: z.string().min(1),
    gtin: z.string().optional(),
  }),
  // PATCH body: each key maps to true/false (set) or null (clear).
  conditionFlagsSet: z.object({
    id: z.string().min(1),
    flags: z
      .record(z.string(), z.union([z.boolean(), z.null()]))
      .describe("Record<flagKey, boolean|null>. Valid keys are category-specific (battery: hasBMS, rechargeable, externalStorageOnly, isStationaryBess). null clears the flag."),
  }),
  conditionFlagsSetBySerial: z.object({
    serial: z.string().min(1),
    gtin: z.string().optional(),
    flags: z
      .record(z.string(), z.union([z.boolean(), z.null()]))
      .describe("Record<flagKey, boolean|null>. null clears the flag."),
  }),

  measurementsCapture: z.object({
    id: z.string().min(1),
    measurements: z.array(measurementSchema).min(1).max(500),
  }),
  measurementsCaptureBySerial: z.object({
    serial: z.string().min(1),
    gtin: z.string().optional(),
    measurements: z.array(measurementSchema).min(1).max(500),
  }),
  measurementsList: z.object({
    id: z.string().min(1),
    fieldKey: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  measurementsListBySerial: z.object({
    serial: z.string().min(1),
    gtin: z.string().optional(),
    fieldKey: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),

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
      "- create — args: { name, model, category, description? }. `category` is one of: battery, textile, electronics, construction, steel, detergents, paints-coatings, packaging, furniture, tyres, jewelry, toys, fmcg.\n" +
      "- update — args: { id, name?, model?, description? }; pass at least one field to change.\n" +
      "- create_batch — args: { products: [ { name, model, category, description? }, … ] }, up to 100. Partial-success: the response carries a per-item status, so some items can be created while others error. The whole batch consumes N writes upfront; if that would exceed the daily cap NOTHING is created (429).\n" +
      "- archive — args: { id }. Soft-archive a product. Blocked with 409 while any non-archived passport still references it — archive those passports first. This is reversible and is NOT deletion.",
    inputSchema: {
      action: z
        .enum(["list", "get", "create", "create_batch", "update", "archive"])
        .describe(
          "Which product operation to run: list | get | create | create_batch | update | archive.",
        ),
      args: z
        .object({
          id: z.string().optional().describe("Product id. Required for get and update."),
          name: z.string().optional().describe("Product name. Required for create; optional on update."),
          model: z.string().optional().describe("Manufacturer model / SKU. Required for create; optional on update."),
          category: z.string().optional().describe("DPP category for create: battery | textile | electronics | construction | steel | detergents | paints-coatings | packaging | furniture | tyres | jewelry | toys | fmcg."),
          description: z.string().optional().describe("Free-text product description (create/update)."),
          page: z.number().optional().describe("Page number for list (1-based)."),
          limit: z.number().optional().describe("Page size for list, max 100."),
          status: z.string().optional().describe("Filter list by product status."),
          search: z.string().optional().describe("Filter list by a search term."),
          products: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe(
              "Products to create for create_batch: [{ name, model, category, description? }], max 100.",
            ),
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
        case "create_batch": {
          const p = parseArgs(SCHEMAS.productCreateBatch, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          return apiResult(await client.post("/api/v1/products/batch", p));
        }
        case "update": {
          const p = parseArgs(SCHEMAS.productUpdate, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          const { id, ...patch } = p;
          return apiResult(await client.patch(`/api/v1/products/${seg(id)}`, patch));
        }
        case "archive": {
          const p = parseArgs(SCHEMAS.productArchive, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          return apiResult(await client.post(`/api/v1/products/${seg(p.id)}/archive`));
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
      "IMPORTANT: `create` consumes DPP slots and IS BILLABLE. Over-quota creation incurs a per-passport charge; the tool surfaces a 402-style message — only re-run with args.confirmOverage=true after the user explicitly agrees. `archive` is IRREVERSIBLE (the public QR permanently 404s); prefer `suspend` when a change might be undone.\n\n" +
      "IDENTIFIER SCHEMES (EN 18219): passports are identified by one of five schemes. Battery passports (Battery Regulation Art. 77(3)) accept ONLY gs1 and iso15459.\n" +
      "  • gs1 — { scheme:\"gs1\", gtin, serialNumber } — GS1 GTIN + serial; gtin is 8/12/13/14 digits, stored as GTIN-14.\n" +
      "  • iso15459 — { scheme:\"iso15459\", issuingAgencyCode, primaryId, serial? } — ISO/IEC 15459; the server derives raw (IAC + primaryId + serial).\n" +
      "  • iec61406 — { scheme:\"iec61406\", uri } — IEC 61406 Identification Link (https URI). Not valid for batteries.\n" +
      "  • did — { scheme:\"did\", did, method } — W3C DID Core. Not valid for batteries.\n" +
      "  • doi — { scheme:\"doi\", doi, granularity:\"model\"|\"batch\"|\"item\" } — ISO 26324 DOI, stored as bare 10.<registrant>/<suffix> (any https://doi.org/ or doi: prefix stripped on input; resolves as https://doi.org/<doi>); granularity REQUIRED per EN 18219 §5.6.2(b). Not valid for batteries.\n" +
      "The legacy top-level gtin + serialNumber pair is still accepted as a deprecated alias for scheme:\"gs1\".\n\n" +
      "Actions (pass via `action`, with `args`):\n" +
      "- list — args: { page?, limit? (≤100), productId?, status?, search? }. status ∈ draft|in_review|approved|published|suspended|expired|archived. Read-only.\n" +
      "- get — args: { id, format? (summary|full), lang? }. Read-only. Response includes `identifier`, `identifierKey`, and (for GS1 passports) `gs1`.\n" +
      "- get_by_serial — args: { serial, format?, lang?, gtin? }. Read-only. Addresses the passport by your own serial. A serial is unique only WITHIN a GTIN — if the same serial exists under two GTINs in your account the call returns 409 ambiguous_serial; pass `gtin` (or use the by-id action) to resolve exactly.\n" +
      "- compliance — args: { id }. Read-only. Returns a three-tier compliance verdict (compliant | compliant_with_warnings | incomplete) with regulation-cited findings — use to gap-check a passport against the rules for its category, fix the cited fields/parties, then re-check. Also returns byRegulation[]: the same findings grouped per regulation, worst first, so you can tell WHICH regime is failing instead of reading one `incomplete` as everything being wrong. A regulation absent from that array raised no finding — that is not the same as it having passed.\n" +
      "- registry_readiness — args: { id }. Read-only. Returns { ready, findings[] } — whether the passport would pass the EU DPP Registry's FORMAL submission gate (mandatory fields present, correct formatting, a resolvable public link, item-level granularity via a serial number, and a well-formed commodity code where the category carries one). This is the registry's mechanical pre-submission check, NOT the substantive compliance verdict; a passport can be registry-ready yet not substantively compliant. Battery passports only.\n" +
      "- create — args: { productId, identifier?, gtin?, serialNumber?, confirmOverage?, lineage? }. BILLABLE. Provide identifier (preferred) or legacy gtin + serialNumber. Battery passports accept only gs1 and iso15459 schemes — other schemes return 400. A duplicate identifier returns 409.\n" +
      "  lineage (battery only) — a repurposed, remanufactured or reused battery needs a NEW passport linked to the original(s) (Battery Regulation Art. 77(7)): { predecessors: [ { internalPassportId? | identifier?, trigger: preparation_for_reuse|preparation_for_repurposing|repurposing|remanufacturing } ] (≤10), noPredecessorReason? (only with an empty list, e.g. placed on the market before 18 Feb 2027) }. The server derives batteryStatus from the triggers and links your own predecessor passports back. Immutable after create. Rule violations return 422 with the rule code (duplicate_predecessor, predecessor_not_found, status_trigger_mismatch, …).\n" +
      "- suspend — args: { id }. Reversible — public QR shows 'suspended'.\n" +
      "- suspend_by_serial — args: { serial, gtin? }. Same as suspend, addressed by your serial. 409 ambiguous_serial if the serial isn't unique in your account — pass `gtin`.\n" +
      "- archive — args: { id }. IRREVERSIBLE — confirm with the user first.\n" +
      "- archive_by_serial — args: { serial, gtin? }. IRREVERSIBLE, addressed by your serial — confirm first. 409 ambiguous_serial if the serial isn't unique — pass `gtin`.\n" +
      "- get_qr — args: { id, format? (svg|png), symbology? (qr|datamatrix) }. Read-only. symbology=datamatrix renders an ISO/IEC 16022 Data Matrix instead of a QR (EN 18220 permits both; same passport URL).\n" +
      "- get_qr_by_serial — args: { serial, format? (svg|png), symbology? (qr|datamatrix), gtin? }. Read-only. Same as get_qr, addressed by your own serial. A serial is unique only WITHIN a GTIN — if the same serial exists under two GTINs in your account the call returns 409 ambiguous_serial; pass `gtin` (or use get_qr by id) to resolve exactly.\n" +
      "- list_snapshots — args: { id, page?, limit? (≤100), at? (ISO 8601) }. Read-only. Returns a paginated list of snapshots for the passport (newest first). A snapshot is written on publish and after every change to a non-draft passport (EN 18221 change archive); each carries id, version, reason (e.g. published|field_edit|status_change|baseline), actor (who caused it, when known), snapshotAt, contentHash, hashValid (re-verified on every read), restorable, fieldCount. With `at`, returns instead the single snapshot valid at that instant (full record plus validFrom/validUntil) — answers \"what did this passport say on date D\"; 404 before the first snapshot. Counts 1 against the daily read budget.\n" +
      "- get_snapshot — args: { id, snapshotId }. Read-only. Returns the full archival record of one snapshot: the complete JSON-LD the passport asserted at that time, plus hash and hashValid. Counts 1 against the daily read budget.\n" +
      "- get_condition_flags — args: { id }. Read-only. Returns the resolved condition profile Record<flagKey,{value,status,source}>. Condition flags are reviewer-approved yes/no facts gating conditional legal duties. Battery flags: hasBMS, rechargeable, externalStorageOnly, isStationaryBess. An approved flag makes specific fields required — a missing gated field is a hard publish block (conditional_missing). Counts 1 against the daily read budget.\n" +
      "- get_condition_flags_by_serial — args: { serial, gtin? }. Read-only. Same as get_condition_flags, addressed by your own serial. 409 ambiguous_serial if serial not unique — pass gtin.\n" +
      "- set_condition_flags — args: { id, flags: Record<flagKey, boolean|null> }. WRITE. Set or clear condition flags (null clears). Keys must be registered for the passport category (battery: hasBMS, rechargeable, externalStorageOnly, isStationaryBess). WARNING: approving a flag can make fields required and block publishing if those fields are empty — fix any gated fields before or immediately after setting the flag. Writes are approved + audited. Idempotency-Key supported. Counts 1 write.\n" +
      "- set_condition_flags_by_serial — args: { serial, gtin?, flags }. WRITE. Same as set_condition_flags, addressed by your own serial. 409 ambiguous_serial if serial not unique — pass gtin.\n" +
      "- capture_measurements — args: { id, measurements: [ { fieldKey, value, measuredAt (ISO 8601), externalId?, unit? } ] (≤500) }. WRITE, battery passports only, published only. Pushes over-life measurements from the customer's own equipment (e.g. a BMS reporting stateOfHealth, numberOfFullEquivalentChargingCycles; the Annex XIII point 4 use-data keys). Every measurement is stored; the newest per field becomes the passport's current value and sets dynamicDataAsOf. externalId makes a measurement idempotent. A value may be at most 16 KB serialised. batteryStatus is NOT a measurement (400 invalid_field_key). A key the Regulation keeps off this battery category returns 422 field_not_applicable (e.g. stateOfCertifiedEnergy on an LMT battery). Metered against the plan's monthly measurement allowance, not the daily write budget: paid plans keep counting past it at no charge; Free stops at its allowance. Reading a passport is never metered.\n" +
      "- capture_measurements_by_serial — args: { serial, gtin?, measurements }. Same, addressed by your own serial.\n" +
      "- list_measurements — args: { id, fieldKey?, from?, to? (ISO 8601), limit? (≤200), cursor? }. Read-only. Measurement history, newest first; page with the returned nextCursor.\n" +
      "- list_measurements_by_serial — args: { serial, gtin?, fieldKey?, from?, to?, limit?, cursor? }. Read-only.\n" +
      "- latest_measurements — args: { id }. Read-only. The newest measurement per accepted key (null where none yet).\n" +
      "- latest_measurements_by_serial — args: { serial, gtin? }. Read-only.",
    inputSchema: {
      action: z
        .enum([
          "list",
          "get",
          "get_by_serial",
          "compliance",
          "registry_readiness",
          "get_condition_flags",
          "get_condition_flags_by_serial",
          "set_condition_flags",
          "set_condition_flags_by_serial",
          "capture_measurements",
          "capture_measurements_by_serial",
          "list_measurements",
          "list_measurements_by_serial",
          "latest_measurements",
          "latest_measurements_by_serial",
          "create",
          "suspend",
          "suspend_by_serial",
          "archive",
          "archive_by_serial",
          "get_qr",
          "get_qr_by_serial",
          "list_snapshots",
          "get_snapshot",
        ])
        .describe(
          "Which passport operation to run. Reads: list | get | get_by_serial | compliance | registry_readiness | get_condition_flags | get_condition_flags_by_serial | get_qr | get_qr_by_serial | list_snapshots | get_snapshot | list_measurements(_by_serial) | latest_measurements(_by_serial). Writes: set_condition_flags | set_condition_flags_by_serial | capture_measurements(_by_serial) | create (BILLABLE). Lifecycle: suspend (reversible) | archive (IRREVERSIBLE), each with a _by_serial variant.",
        ),
      args: z
        .object({
          id: z.string().optional().describe("Passport id. Required for get/compliance/suspend/archive/get_qr (the by-id actions)."),
          serial: z.string().optional().describe("Your own serial number. Required for the *_by_serial actions."),
          gtin: z
            .string()
            .optional()
            .describe(
              "For create (legacy): GS1 GTIN. Also used as a disambiguator for *_by_serial actions when a serial isn't unique (else 409 ambiguous_serial).",
            ),
          productId: z.string().optional().describe("Parent product id. Required for create."),
          identifier: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "EN 18219 scheme-tagged identifier for create. Must have `scheme` plus scheme-specific fields. Schemes: gs1 {gtin, serialNumber} | iso15459 {issuingAgencyCode, primaryId, serial?} | iec61406 {uri} | did {did, method} | doi {doi, granularity} (granularity: \"model\"|\"batch\"|\"item\" REQUIRED per EN 18219 §5.6.2(b)). Battery passports: gs1 and iso15459 only.",
            ),
          serialNumber: z.string().optional().describe("Serial for the new passport (create, legacy gs1 path)."),
          confirmOverage: z.boolean().optional().describe("Set true to accept per-passport overage charges when over the plan quota (402). Applies to create."),
          lineage: lineageSchema
            .optional()
            .describe("create, battery only: link a second-life battery's new passport to the original passport(s) (Art. 77(7)). See the create action."),
          format: z.string().optional().describe("get/get_by_serial: summary|full. get_qr/get_qr_by_serial: svg|png."),
          symbology: z.string().optional().describe("get_qr/get_qr_by_serial: qr (default) | datamatrix."),
          at: z.string().optional().describe("list_snapshots: ISO 8601 instant — return the snapshot valid then instead of the list."),
          lang: z.string().optional().describe("Resolve field values to one of the 24 EU locales server-side (get/get_by_serial)."),
          page: z.number().optional().describe("Page number for list (1-based)."),
          limit: z.number().optional().describe("Page size for list, max 100."),
          status: z.string().optional().describe("Filter list by status: draft|in_review|approved|published|suspended|expired|archived."),
          search: z.string().optional().describe("Filter list by a search term."),
          snapshotId: z.string().optional().describe("Snapshot id. Required for get_snapshot."),
          measurements: z
            .array(measurementSchema)
            .optional()
            .describe("capture_measurements(_by_serial): [{ fieldKey, value, measuredAt, externalId?, unit? }], max 500."),
          fieldKey: z.string().optional().describe("list_measurements(_by_serial): only this field key."),
          from: z.string().optional().describe("list_measurements(_by_serial): measuredAt from (ISO 8601)."),
          to: z.string().optional().describe("list_measurements(_by_serial): measuredAt to (ISO 8601)."),
          cursor: z.string().optional().describe("list_measurements(_by_serial): nextCursor from the previous page."),
          flags: z
            .record(z.string(), z.union([z.boolean(), z.null()]))
            .optional()
            .describe("For set_condition_flags / set_condition_flags_by_serial: Record<flagKey, boolean|null>. null clears the flag."),
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
        case "registry_readiness": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/passports/${seg(p.id)}/registry-readiness`));
        }
        case "create": {
          const p = parseArgs(SCHEMAS.passportCreate, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          const body: Record<string, unknown> = { productId: p.productId };
          if (p.identifier) {
            // EN 18219 scheme-tagged path (preferred for all new integrations).
            body.identifier = p.identifier;
          } else {
            // Legacy flat GS1 fields — still accepted as a deprecated alias.
            body.gs1 = { gtin: p.gtin, serialNumber: p.serialNumber };
          }
          if (p.confirmOverage) body.confirmOverage = true;
          if (p.lineage) body.lineage = p.lineage;
          return apiResult(await client.post("/api/v1/passports", body));
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
            await client.get(`/api/v1/passports/${seg(p.id)}/qr${qs({ format: p.format, symbology: p.symbology })}`),
          );
        }
        case "get_qr_by_serial": {
          const p = parseArgs(SCHEMAS.passportQrBySerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(
              `/api/v1/passports/by-serial/${seg(p.serial)}/qr${qs({ format: p.format, symbology: p.symbology, gtin: p.gtin })}`,
            ),
          );
        }
        case "list_snapshots": {
          const p = parseArgs(SCHEMAS.snapshotList, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(`/api/v1/passports/${seg(p.id)}/snapshots${qs({ page: p.page, limit: p.limit, at: p.at })}`),
          );
        }
        case "get_snapshot": {
          const p = parseArgs(SCHEMAS.snapshotGet, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(`/api/v1/passports/${seg(p.id)}/snapshots/${seg(p.snapshotId)}`),
          );
        }
        case "get_condition_flags": {
          const p = parseArgs(SCHEMAS.conditionFlagsGet, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/passports/${seg(p.id)}/condition-flags`));
        }
        case "get_condition_flags_by_serial": {
          const p = parseArgs(SCHEMAS.conditionFlagsGetBySerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(
              `/api/v1/passports/by-serial/${seg(p.serial)}/condition-flags${qs({ gtin: p.gtin })}`,
            ),
          );
        }
        case "set_condition_flags": {
          const p = parseArgs(SCHEMAS.conditionFlagsSet, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.patch(`/api/v1/passports/${seg(p.id)}/condition-flags`, p.flags),
          );
        }
        case "set_condition_flags_by_serial": {
          const p = parseArgs(SCHEMAS.conditionFlagsSetBySerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.patch(
              `/api/v1/passports/by-serial/${seg(p.serial)}/condition-flags${qs({ gtin: p.gtin })}`,
              p.flags,
            ),
          );
        }
        case "capture_measurements": {
          const p = parseArgs(SCHEMAS.measurementsCapture, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.post(`/api/v1/passports/${seg(p.id)}/measurements`, { measurements: p.measurements }),
          );
        }
        case "capture_measurements_by_serial": {
          const p = parseArgs(SCHEMAS.measurementsCaptureBySerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.post(
              `/api/v1/passports/by-serial/${seg(p.serial)}/measurements${qs({ gtin: p.gtin })}`,
              { measurements: p.measurements },
            ),
          );
        }
        case "list_measurements": {
          const p = parseArgs(SCHEMAS.measurementsList, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          const { id, ...q } = p;
          return apiResult(await client.get(`/api/v1/passports/${seg(id)}/measurements${qs(q)}`));
        }
        case "list_measurements_by_serial": {
          const p = parseArgs(SCHEMAS.measurementsListBySerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          const { serial, ...q } = p;
          return apiResult(await client.get(`/api/v1/passports/by-serial/${seg(serial)}/measurements${qs(q)}`));
        }
        case "latest_measurements": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/passports/${seg(p.id)}/measurements/latest`));
        }
        case "latest_measurements_by_serial": {
          const p = parseArgs(SCHEMAS.passportSerial, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(`/api/v1/passports/by-serial/${seg(p.serial)}/measurements/latest${qs({ gtin: p.gtin })}`),
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
      "Update field values on a Digital Product Passport. Every change is recorded in the passport's audit trail with the credential that made it (API key or connected app) and this MCP channel.\n\n" +
      "`source` (optional) says where the value came from. Omit it, or pass \"manual\", when the user gave you the value or it comes from their own records: it is written with the user's rights (approved for an API key or an admin; sent to review for a connected app acting for an editor). Pass \"ai_suggested\" when you found or inferred the value yourself (web research, reading a document): it lands in the dashboard review queue for a human to approve, and it is refused on fields only the economic operator may state or that must be measured (e.g. battery stateOfHealth).\n\n" +
      "Actions (pass via `action`, with `args`):\n" +
      "- update — args: { id, fieldKey, value, source? }. `value` type matches the field's dataType (string, number, boolean, array, object).\n" +
      "- update_by_serial — args: { serial, fieldKey, value, gtin?, source? }. Same as update, addressed by your own serial. A serial is unique only WITHIN a GTIN — if it isn't unique in your account the call returns 409 ambiguous_serial; pass `gtin` (or use update by id) to resolve exactly.",
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
          source: FIELD_SOURCE.optional().describe("Where the value came from: \"manual\" (default — the user's statement) or \"ai_suggested\" (you found it; it goes to human review)."),
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
              ...(p.source ? { source: p.source } : {}),
            }),
          );
        }
        case "update_by_serial": {
          const p = parseArgs(SCHEMAS.fieldUpdateBySerial, a.args, "tracepass_passport_fields", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.patch(
              `/api/v1/passports/by-serial/${seg(p.serial)}/fields/${seg(p.fieldKey)}${qs({ gtin: p.gtin })}`,
              { value: p.value, ...(p.source ? { source: p.source } : {}) },
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
      "Manage the economic-operator parties on a passport — manufacturer, importer, authorisedRepresentative, distributor, recycler, producerResponsibilityOrg. Each party carries a legal name and at least one identifier.\n\n" +
      "Identifier rules (EN 18219 §6.2–6.5): a party needs at least one of `gln`, `legacyOperatorId`, or `operatorIdentifier`. " +
      "If both `gln` and `operatorIdentifier` (scheme gln) are provided they must agree — a mismatch returns 400. " +
      "An operatorIdentifier of scheme gln also fills the top-level `gln` field; facilityIdentifier never does. " +
      "Typed identifiers (operatorIdentifier / facilityIdentifier) are not set by AI extraction or CSV import.\n\n" +
      "operatorIdentifier schemes:\n" +
      "  • iso6523 — { scheme:\"iso6523\", icd:\"<4 digits>\", value } — ICD 0199 = LEI (ISO 17442), 0088 = GLN, 0060 = DUNS.\n" +
      "  • gln — { scheme:\"gln\", gln:\"<13 digits>\" } — also fills top-level `gln`.\n" +
      "  • did — { scheme:\"did\", did:\"did:<method>:<id>\" } — syntax-checked only (EN 18219 §6.4.2(b)).\n" +
      "  • doi — { scheme:\"doi\", doi:\"10.<registrant>/<suffix>\" } — doi:/https://doi.org/ prefix accepted and stripped.\n\n" +
      "facilityIdentifier schemes: same four; the gln variant also accepts optional `extension` (GS1 SGLN sub-location).\n\n" +
      "Actions (pass via `action`, with `args`):\n" +
      "- set — args: { id, role, legalName, gln?, country?, legacyOperatorId?, operatorIdentifier?, facilityIdentifier? }. Sets or updates one role.\n" +
      "- remove — args: { id, role }. Clears one role.",
    inputSchema: {
      action: z
        .enum(["set", "remove"])
        .describe("Set (add/replace) or remove an economic-operator party on a passport by its role."),
      args: z
        .object({
          id: z.string().optional().describe("Passport id (required)."),
          role: z.string().optional().describe("Economic-operator role: manufacturer | importer | authorisedRepresentative | distributor | recycler | producerResponsibilityOrg (required)."),
          legalName: z.string().optional().describe("Party legal name. Required for set."),
          gln: z.string().optional().describe("GS1 Global Location Number (13 digits). Strongly recommended for multi-role disambiguation."),
          country: z.string().optional().describe("ISO 3166-1 alpha-2 country code (set, optional)."),
          legacyOperatorId: z.string().optional().describe("Free-text fallback identifier (VAT, EORI, supplier code). Required when gln and operatorIdentifier are both absent."),
          operatorIdentifier: z.record(z.string(), z.unknown()).optional().describe(
            "Structured operator identifier per EN 18219 §6.2–6.5. Must have `scheme` plus scheme fields. " +
            "Schemes: iso6523 {icd:\"<4 digits>\", value} | gln {gln:\"<13 digits>\"} | did {did:\"did:<method>:<id>\"} | doi {doi:\"10.<registrant>/<suffix>\"}. " +
            "scheme gln also fills the top-level gln field; they must match if both are set (400 otherwise). Not set by AI extraction.",
          ),
          facilityIdentifier: z.record(z.string(), z.unknown()).optional().describe(
            "Structured facility identifier per EN 18219 §6.2–6.5. Same four schemes as operatorIdentifier; " +
            "the gln variant also accepts optional `extension` (GS1 SGLN sub-location). Never fills the top-level gln field. Not set by AI extraction.",
          ),
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
      "- list — args: {}. Lists all 13 categories with their field count, required-field count, and governing regulation (name + number + effective/mandatory dates).\n" +
      "- get — args: { category }. Full field schema for one category: every field's key, label, dataType, whether it is REQUIRED, its access level (public/restricted/authority), enum options, validation bounds, and — where known — the regulation article/annex that mandates it. `category` is one of: battery, textile, electronics, construction, steel, detergents, paints-coatings, packaging, furniture, tyres, jewelry, toys, fmcg.\n\n" +
      "BATTERY — required-ness is per-category, so `required` alone is the wrong answer. Resolve it in this order:\n" +
      "  1. SCOPE FIRST. Only EV, LMT and industrial_gt_2kwh batteries owe a passport at all (Art. 77(1), Reg (EU) 2023/1542). For portable, SLI or industrial_lte_2kwh, NO field is required — do not list mandatory fields for them; say the battery is out of scope.\n" +
      "  2. Then `requiredBy[batteryCategory]` where the field carries that map (required | conditional | notApplicable).\n" +
      "  3. Then fall back to `required`.\n" +
      "The map is keyed ONLY by the three in-scope categories, so skipping step 1 falls through to `required` and invents an obligation the Regulation does not impose. Note also that EV and LMT report state-of-health through MUTUALLY EXCLUSIVE field sets — an EV battery must leave the remaining-capacity cluster empty and an LMT battery must leave stateOfCertifiedEnergy empty, so no single battery ever fills every field.",
    inputSchema: {
      action: z
        .enum(["list", "get"])
        .describe("List all DPP category templates, or get one template by category."),
      args: z
        .object({
          category: z.string().optional().describe("DPP category to fetch (required for get): battery | textile | electronics | construction | steel | detergents | paints-coatings | packaging | furniture | tyres | jewelry | toys | fmcg."),
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
