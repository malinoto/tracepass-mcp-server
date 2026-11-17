/**
 * MCP tool definitions for the TracePass v1 API.
 *
 * The v1 surface has ~23 endpoints. Exposing 23 flat MCP tools would
 * swamp the model's tool list and slow tool selection. Instead the
 * surface is grouped into eight resource tools, each taking:
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
 * `annotations` carry MCP hint flags at the tool level, all four set
 * explicitly (directories reject a tool that leaves one implicit, and
 * the spec defaults are the pessimistic ones). A hint describes the
 * tool as a whole, so a tool with any write action is not read-only
 * and a tool with any overwrite / remove / archive action is
 * destructive. Per-action risk (billable / irreversible) is spelled
 * out in the description so the model warns the user first.
 *
 * Transport-agnostic: `buildTools(client)` binds the handlers to a
 * `TracePassClient`; the server factory registers them.
 */

import { z } from "zod";
import type { TracePassClient } from "./api-client.js";
import { apiResult, errorResult, textOf, type ToolResult } from "./result.js";

/**
 * MCP tool hints. Required here, unlike in the protocol, so a new tool
 *  cannot ship with a hint left to the spec's pessimistic default.
 */
export interface ToolAnnotations {
  /** No action changes anything. */
  readOnlyHint: boolean;
  /** Some action overwrites, removes or archives (not only additive). */
  destructiveHint: boolean;
  /** Repeating a call with the same args has no further effect. */
  idempotentHint: boolean;
  /** Reaches outside the TracePass account (the open web, third parties). */
  openWorldHint: boolean;
}

/** One tool as registered on the server: its name, description, input schema and handler. */
export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /**
   * Declared shape of the tool's structured result, so MCP clients (and
   *  catalogues like Smithery) can validate + display the output. The tools
   *  pass v1 API JSON straight through, so this describes that envelope.
   */
  outputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Thrown when a value passed to seg() is rejected as a path segment. Kept as a
 * named, exported class so server.ts can surface the message directly rather than
 * hiding it behind a generic "Tool failed unexpectedly" wrapper.
 */
export class SegError extends Error {
  /**
   * Build the error with the message shown to the model.
   * @param msg what was wrong with the input
   */
  public constructor(msg: string) {
    super(msg);
    this.name = "SegError";
  }
}

/**
 * Encode a path segment for use in a v1 URL. Rejects empty strings, ".", and
 * ".." — all three are valid URI characters that encodeURIComponent leaves
 * intact, but all three cause URL normalisation to traverse to a different path
 * (e.g. /api/v1/products/.. normalises to /api/v1/). The Zod schemas already
 * enforce min(1), so the empty check is defence-in-depth; "." and ".." are the
 * real risk.
 * @param s the raw path segment
 * @returns the encoded segment
 */
function seg(s: string): string {
  if (s === "" || s === "." || s === "..") {
    throw new SegError(
      `Invalid path segment ${JSON.stringify(s)} — must not be ".", ".." or empty.`,
    );
  }
  return encodeURIComponent(s);
}

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
  id: z.string().optional(),
  // List reads return a paginated envelope.
  items: z.array(z.unknown()).optional(),
  total: z.number().optional(),
  page: z.number().optional(),
  limit: z.number().optional(),
  totalPages: z.number().optional(),
  // Non-object bodies (e.g. a QR SVG/PNG string) are wrapped as { result: … }.
  result: z.unknown().optional(),
  // Error envelope (also returned as isError text, but a structured copy may ride along).
  // Some API responses include `"error": null` (e.g. scope/catalogue/runs/{id}) — nullish accepts null | undefined | string.
  error: z.string().nullish(),
  message: z.string().nullish(),
} as const;

/**
 * A ZodRawShape that validates the open API envelope without rejecting
 *  action-specific fields. (Spread into each tool's `outputSchema`.)
 */
const API_OUTPUT_SCHEMA: z.ZodRawShape = apiOutputShape;

/**
 * Build a query string from defined values only.
 * @param params name to value pairs; undefined values are skipped
 * @returns the query string with a leading "?", or "" when nothing is defined
 */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
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
 * @param schema the per-action Zod schema
 * @param args the raw `args` object from the tool call
 * @param tool tool name, used in the error text
 * @param action action name, used in the error text
 * @returns the parsed args, or an error result
 */
function parseArgs<T extends z.ZodType>(
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
/**
 * The archive request body: `{ reason }` when one was given, else none.
 * @param reason why the record is archived, if given
 * @returns the request body, or undefined when there is no reason
 */
function archiveBody(reason: string | undefined): Record<string, unknown> | undefined {
  return reason === undefined ? undefined : { reason };
}

/**
 * Type guard — did parseArgs return an error result?
 * @param v the value returned by parseArgs
 * @returns true when the value is an error result
 */
function isErr(v: unknown): v is ToolResult {
  return typeof v === "object" && v !== null && "content" in v;
}

/**
 * A field value. `z.unknown()` alone accepts a missing key, and the platform
 * answers a field update with no `value` with 400, so the omission is caught
 * here with a message the model can act on. `null` is a value: it clears the
 * field.
 */
const FIELD_VALUE = z
  .unknown()
  .refine((v) => v !== undefined, { message: "value is required (pass null to clear the field)" });

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
    uri: z.url(),
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
    did: z
      .string()
      .regex(
        /^did:[a-z0-9]+:.+/,
        "DID must match did:<method>:<id> with lowercase alphanumeric method",
      )
      .max(512),
  }),
  z.object({
    scheme: z.literal("doi"),
    doi: z
      .string()
      .regex(
        /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i,
        "DOI must be a valid 10.<4-9 digits>/<suffix> (bare or with doi:/URL prefix)",
      )
      .max(512),
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
    did: z
      .string()
      .regex(
        /^did:[a-z0-9]+:.+/,
        "DID must match did:<method>:<id> with lowercase alphanumeric method",
      )
      .max(512),
  }),
  z.object({
    scheme: z.literal("doi"),
    doi: z
      .string()
      .regex(
        /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i,
        "DOI must be a valid 10.<4-9 digits>/<suffix> (bare or with doi:/URL prefix)",
      )
      .max(512),
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
          trigger: z.enum([
            "preparation_for_reuse",
            "preparation_for_repurposing",
            "repurposing",
            "remanufacturing",
          ]),
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

/**
 * Origin a caller may declare on a field write. Omitted → the API default,
 *  `manual` (the caller's own statement). `ai_suggested` sends the value to the
 *  dashboard review queue instead of approving it — for values the agent found
 *  itself rather than was told. The platform refuses other origins from API
 *  callers, so only these two are offered.
 */
const FIELD_SOURCE = z.enum(["manual", "ai_suggested"]);

/**
 * Why a passport is archived. The platform requires one of these for a battery
 *  passport (400 reason_required / invalid_reason otherwise) and validates it
 *  when given for any other category. Sent as the JSON body `{ reason }`.
 */
const ARCHIVE_REASON = z.enum(["recycled", "never_placed", "duplicate_or_error"]);

const SCHEMAS = {
  productList: z.object({
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
    category: z.string().optional(),
    status: z.string().optional(),
    search: z.string().optional(),
  }),
  productGet: z.object({ id: z.string().min(1) }),
  // zip is left out: the client reads a body as text, which would corrupt a binary archive.
  productLinks: z.object({
    id: z.string().min(1),
    format: z.enum(["json", "csv"]).optional(),
    limit: z.number().int().positive().max(5000).optional(),
    cursor: z.string().min(1).optional(),
  }),
  productModelQr: z.object({
    id: z.string().min(1),
    format: z.enum(["svg", "png"]).optional(),
    gtin: z
      .string()
      .regex(/^[0-9]{14}$/, "gtin must be 14 digits")
      .optional(),
  }),
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
    .refine(
      (v) =>
        (v.name !== undefined && v.name !== "") ||
        (v.model !== undefined && v.model !== "") ||
        v.description !== undefined,
      { message: "pass at least one of name, model, description" },
    ),
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
      lineage: lineageSchema.optional(),
    })
    .refine(
      (v) => v.identifier !== undefined || (v.gtin !== undefined && v.serialNumber !== undefined),
      {
        message: "provide either identifier (with scheme) or the legacy gtin + serialNumber",
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
  passportArchive: z.object({
    id: z.string().min(1),
    reason: ARCHIVE_REASON.optional(),
  }),
  passportArchiveBySerial: z.object({
    serial: z.string().min(1),
    gtin: z.string().optional(),
    reason: ARCHIVE_REASON.optional(),
  }),
  // ── EU DPP Registry (the operator submits on the Registry website) ──
  // The upload file holds at most 100 passports; the platform refuses more.
  registryUploadFile: z.object({
    passportIds: z.array(z.string().min(1)).min(1).max(100),
  }),
  // An acceptance-environment test result the operator reports.
  registryAcceptanceTest: z.object({
    id: z.string().min(1),
    result: z.enum(["passed", "failed"]),
    errorCode: z.string().max(100).optional(),
  }),
  // A production registration the operator reports.
  registryRegistration: z.object({
    id: z.string().min(1),
    placedOnMarketAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "placedOnMarketAt must be a YYYY-MM-DD date")
      .optional(),
    registrationId: z.string().max(200).optional(),
  }),
  registryRegistrationUndo: z.object({
    id: z.string().min(1),
    environment: z.enum(["production", "acceptance"]),
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
    value: FIELD_VALUE,
    source: FIELD_SOURCE.optional(),
  }),
  fieldUpdateBySerial: z.object({
    serial: z.string().min(1),
    fieldKey: z.string().min(1),
    value: FIELD_VALUE,
    gtin: z.string().optional(),
    source: FIELD_SOURCE.optional(),
  }),

  partySet: z.object({
    id: z.string().min(1),
    role: partyRoleEnum,
    legalName: z.string().min(1),
    gln: z.string().optional(),
    country: z.string().optional(),
    url: z.string().optional(),
    tradeName: z.string().optional(),
    postalAddress: z.string().optional(),
    email: z.string().optional(),
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
      .describe(
        "Record<flagKey, boolean|null>. Valid keys are category-specific (battery: hasBMS, rechargeable, externalStorageOnly, isStationaryBess). null clears the flag.",
      ),
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

  // ── scope services ───────────────────────────────────────────
  scopeCheck: z.object({
    category: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Product category: battery | detergents | toys | construction | textile | steel | tyres | furniture | electronics | packaging | paints-coatings | jewelry | fmcg | vehicles | other.",
      ),
    facts: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Namespace-prefixed fact keys declared by the loaded rules (e.g. battery.use, battery.capacityKWh). Unknown keys or wrong values return 400.",
      ),
    role: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Role hint (e.g. manufacturer, importer, distributor, ownBrand). The platform resolves the act-specific term.",
      ),
    placedOnMarket: z
      .object({
        date: z.string().min(1).describe("YYYY-MM-DD, YYYY-MM or YYYY"),
        precision: z.enum(["day", "month", "year"]).optional(),
      })
      .nullable()
      .optional(),
    lifecycleEvent: z
      .string()
      .nullable()
      .optional()
      .describe("Lifecycle event (end-of-life, second-life, etc.)."),
    contains: z
      .array(
        z.object({
          label: z.string().max(60).optional(),
          facts: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .max(5)
      .optional()
      .describe("Component queries (max 5) — e.g. 'Does this toy contain a battery?'"),
    productId: z
      .string()
      .nullable()
      .optional()
      .describe("Add saved product facts and passport data (ObjectId)."),
    passportId: z.string().nullable().optional().describe("Add saved passport facts (ObjectId)."),
    locale: z.enum(["en", "bg", "de", "it"]).optional().describe("Answer language (default: en)."),
  }),
  catalogueReport: z.object({
    classification: z
      .string()
      .optional()
      .describe(
        "Filter by passport status: missing | draft_only | published_incomplete | published | not_required | open_questions | not_covered.",
      ),
    category: z.string().optional().describe("Filter by DPP category (e.g. battery)."),
    act: z.string().optional().describe("Filter by governing act (CELEX, e.g. 32023R1542)."),
    changed: z.boolean().optional().describe("true = return only rows changed since the last run."),
    q: z.string().optional().describe("Search by product name or GTIN."),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from the previous response's nextCursor."),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Page size (default 50, max 500)."),
  }),
  catalogueRun: z.object({}),
  catalogueRunStatus: z.object({ runId: z.string().min(1).describe("Run id from catalogue_run.") }),
} as const;

/**
 * Build the 8 grouped tools, bound to a TracePass API client.
 * @param client API client carrying the caller credential
 * @returns the tool definitions
 */
export function buildTools(client: TracePassClient): McpToolDefinition[] {
  // ─────────────────────────── products ────────────────────────
  const productsTool: McpToolDefinition = {
    name: "tracepass_products",
    title: "TracePass products",
    description:
      "Manage the TracePass product catalogue. A product is the catalogue layer — one product can have many passports (one per serialised unit). Products are not billable on their own. Archive is in tracepass_passport_lifecycle.\n\n" +
      "Actions (pass via `action`; `{…}` is the `args` object):\n- list — { page?, limit? (≤100), category?, status?, search? }. Read-only.\n- get — { id }. Read-only.\n- create — { name, model, category, description? }. `category` is one of the 13 DPP categories (tracepass_templates list).\n- update — { id, name?, model?, description? }; at least one field.\n- get_links — { id, format? (json|csv), limit? (≤5000), cursor? (json: prior nextCursor) }. Every PUBLISHED passport's serial, passportUrl, status (json adds qrApiUrl, needs your API credentials) plus the model page URL, for a dealer asking for passport links.\n- get_model_qr — { id, format? (svg|png), gtin? (14 digits) }. QR of the model page. 404 model_not_found; 400 gtin_required (several GTINs) or invalid_gtin.\n- create_batch — { products: [ { name, model, category, description? }, … ] }, up to 100. Partial-success: per-item status, so some can be created while others error. The batch consumes N writes upfront; if that would exceed the daily cap NOTHING is created (429).",
    inputSchema: {
      action: z.enum([
        "list",
        "get",
        "create",
        "create_batch",
        "update",
        "get_links",
        "get_model_qr",
      ]),
      args: z
        .object({
          id: z.string().optional(),
          name: z.string().optional(),
          model: z.string().optional(),
          category: z.string().optional().describe("One of the 13 DPP categories."),
          description: z.string().optional(),
          page: z.number().optional(),
          limit: z.number().optional(),
          status: z.string().optional(),
          search: z.string().optional(),
          format: z.string().optional(),
          gtin: z.string().optional(),
          cursor: z.string().optional(),
          products: z.array(z.record(z.string(), z.unknown())).optional(),
        })
        .partial()
        .optional(),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
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
        case "get_links": {
          const p = parseArgs(SCHEMAS.productLinks, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(
              `/api/v1/products/${seg(p.id)}/links${qs({ format: p.format, limit: p.limit, cursor: p.cursor })}`,
            ),
          );
        }
        case "get_model_qr": {
          const p = parseArgs(SCHEMAS.productModelQr, a.args, "tracepass_products", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(
              `/api/v1/products/${seg(p.id)}/links/model-qr${qs({ format: p.format, gtin: p.gtin })}`,
            ),
          );
        }
        default:
          if (action === "archive") {
            return errorResult(
              `Unknown action "archive" for tracepass_products. Irreversible actions moved to tracepass_passport_lifecycle in 1.24.0.`,
            );
          }
          return errorResult(`Unknown action "${action}" for tracepass_products.`);
      }
    },
  };

  // ────────────────────────── passports ────────────────────────
  const passportsTool: McpToolDefinition = {
    name: "tracepass_passports",
    title: "TracePass passports",
    description:
      "Manage Digital Product Passports — create, read, run compliance checks. Archive, suspend, place on market and record_registration are in tracepass_passport_lifecycle.\n\n" +
      "IMPORTANT: `create` makes a DRAFT passport: no plan DPP slot, never billed. The slot, and any overage past the plan cap, is taken when it is published in the TracePass dashboard, not through this tool. Each create counts against the daily write budget.\n\n" +
      "EU DPP REGISTRY (battery): the operator registers a passport itself, on the Registry website under its own EU Login. TracePass prepares what it submits and records what it reports; it never submits to the Registry and never verifies the outcome. The acceptance environment has no legal effect; production is recorded with record_registration (tracepass_passport_lifecycle). Paid plan; an OAuth app must act for an admin or owner.\n\n" +
      "Identifier schemes (EN 18219): gs1 | iso15459 | iec61406 | did | doi; batteries accept ONLY gs1 and iso15459. Shapes, lineage, snapshots, measurements, refusal codes: resource tracepass://reference/passports.\n\n" +
      "Actions (pass via `action`; `{…}` is the `args` object). Read-only unless marked WRITE. A *_by_serial action takes { serial, gtin? } instead of `id` (on 409 ambiguous_serial pass `gtin`).\n- list — { page?, limit? (≤100), productId?, status?, search? }. status ∈ draft|in_review|approved|published|suspended|expired|archived.\n- get, get_by_serial — { id, format? (summary|full), lang? }.\n- compliance — { id }. compliant | compliant_with_warnings | incomplete, with regulation-cited findings and byRegulation[]. A regulation absent from byRegulation raised no finding, which is not the same as passed.\n- registry_readiness — { id }. Battery only. { ready, findings[] }: the Registry's FORMAL pre-submission check, not the compliance verdict.\n- prepare_registry_upi — { id }. WRITE, battery, published only. { upi, preparedAt } for the operator to paste into the Registry form. Submits nothing.\n- prepare_registry_upload_file — { passportIds (1–100) }. WRITE, battery. { xml, filename, included, excluded }: the operator uploads `xml` on the Registry website; TracePass does not. 1 write per included passport.\n- record_acceptance_test — { id, result: passed|failed, errorCode? }. WRITE, battery, published only. Records what the operator reports from the ACCEPTANCE environment: no legal effect, not verified. Undo: undo_registration (acceptance).\n- create — { productId, identifier?, gtin?, serialNumber?, lineage? }. Draft, not billed. identifier preferred, or legacy gtin + serialNumber. Battery: only gs1/iso15459, else 400. Duplicate: 409. lineage (battery): a repurposed, remanufactured or reused battery needs a NEW passport linked to the original(s) (Art. 77(7)); immutable after create.\n- get_qr, get_qr_by_serial — { id, format? (svg|png), symbology? (qr|datamatrix) }. One passport's QR; the bare GTIN URL is the product's model page (see products get_links).\n- list_snapshots — { id, page?, limit?, at? (ISO 8601) }; get_snapshot — { id, snapshotId }. EN 18221 change archive (`at` = the snapshot valid then). Entries carry contentHash, hashMethod (jcs-sha256 = RFC 8785 + SHA-256; older: sorted-json-sha256), previousHash and, in the list, chainLink plus a chain verdict. 1 read each.\n- get_condition_flags, _by_serial — { id }. Approved yes/no facts that gate conditional duties; an approved flag can make fields required and block publish. 1 read.\n- set_condition_flags, _by_serial — { id, flags: Record<flagKey, boolean|null> }. WRITE; null clears. WARNING: approving a flag can make fields required and block publishing if empty — fix them before or right after.\n- capture_measurements, _by_serial — { id, measurements: [ { fieldKey, value, measuredAt (ISO 8601), externalId?, unit? } ] (≤500) }. WRITE, battery, published only. Over-life data from the customer's equipment; metered against the monthly measurement allowance, not the write budget.\n- list_measurements, _by_serial — { id, fieldKey?, from?, to?, limit? (≤200), cursor? }; latest_measurements, _by_serial — { id }. Read-only.",
    inputSchema: {
      action: z.enum([
        "list",
        "get",
        "get_by_serial",
        "compliance",
        "registry_readiness",
        "prepare_registry_upi",
        "prepare_registry_upload_file",
        "record_acceptance_test",
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
        "get_qr",
        "get_qr_by_serial",
        "list_snapshots",
        "get_snapshot",
      ]),
      args: z
        .object({
          id: z.string().optional(),
          passportIds: z.array(z.string()).optional(),
          result: z.enum(["passed", "failed"]).optional(),
          errorCode: z.string().optional(),
          serial: z.string().optional(),
          gtin: z
            .string()
            .optional()
            .describe("Legacy GS1 GTIN (create), or the disambiguator for *_by_serial."),
          productId: z.string().optional(),
          identifier: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "{ scheme: gs1|iso15459|iec61406|did|doi, … }. Shapes: tracepass://reference/passports.",
            ),
          serialNumber: z.string().optional(),
          lineage: lineageSchema.optional(),
          format: z.string().optional().describe("summary|full (get); svg|png (get_qr)."),
          symbology: z.string().optional().describe("qr (default) | datamatrix."),
          at: z.string().optional(),
          lang: z.string().optional().describe("One of the 24 EU locales (get)."),
          page: z.number().optional(),
          limit: z.number().optional(),
          status: z.string().optional(),
          search: z.string().optional(),
          snapshotId: z.string().optional(),
          measurements: z.array(measurementSchema).optional(),
          fieldKey: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          cursor: z.string().optional(),
          flags: z
            .record(z.string(), z.union([z.boolean(), z.null()]))
            .optional()
            .describe("flagKey → boolean; null clears."),
        })
        .partial()
        .optional(),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
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
            await client.get(
              `/api/v1/passports/${seg(p.id)}${qs({ format: p.format, lang: p.lang })}`,
            ),
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
        case "prepare_registry_upi": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(await client.post(`/api/v1/passports/${seg(p.id)}/registry-upi`));
        }
        case "prepare_registry_upload_file": {
          const p = parseArgs(SCHEMAS.registryUploadFile, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.post("/api/v1/registry/upload-file", { passportIds: p.passportIds }),
          );
        }
        case "record_acceptance_test": {
          const p = parseArgs(
            SCHEMAS.registryAcceptanceTest,
            a.args,
            "tracepass_passports",
            action,
          );
          if (isErr(p)) return p;
          const body: Record<string, unknown> = { environment: "acceptance", result: p.result };
          if (p.errorCode !== undefined) body.errorCode = p.errorCode;
          return apiResult(await client.post(`/api/v1/passports/${seg(p.id)}/registration`, body));
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
          if (p.lineage) body.lineage = p.lineage;
          return apiResult(await client.post("/api/v1/passports", body));
        }
        case "get_qr": {
          const p = parseArgs(SCHEMAS.passportQr, a.args, "tracepass_passports", action);
          if (isErr(p)) return p;
          return apiResult(
            await client.get(
              `/api/v1/passports/${seg(p.id)}/qr${qs({ format: p.format, symbology: p.symbology })}`,
            ),
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
            await client.get(
              `/api/v1/passports/${seg(p.id)}/snapshots${qs({ page: p.page, limit: p.limit, at: p.at })}`,
            ),
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
          const p = parseArgs(
            SCHEMAS.conditionFlagsGetBySerial,
            a.args,
            "tracepass_passports",
            action,
          );
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
          const p = parseArgs(
            SCHEMAS.conditionFlagsSetBySerial,
            a.args,
            "tracepass_passports",
            action,
          );
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
            await client.post(`/api/v1/passports/${seg(p.id)}/measurements`, {
              measurements: p.measurements,
            }),
          );
        }
        case "capture_measurements_by_serial": {
          const p = parseArgs(
            SCHEMAS.measurementsCaptureBySerial,
            a.args,
            "tracepass_passports",
            action,
          );
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
          const p = parseArgs(
            SCHEMAS.measurementsListBySerial,
            a.args,
            "tracepass_passports",
            action,
          );
          if (isErr(p)) return p;
          const { serial, ...q } = p;
          return apiResult(
            await client.get(`/api/v1/passports/by-serial/${seg(serial)}/measurements${qs(q)}`),
          );
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
            await client.get(
              `/api/v1/passports/by-serial/${seg(p.serial)}/measurements/latest${qs({ gtin: p.gtin })}`,
            ),
          );
        }
        default: {
          const MOVED: ReadonlySet<string> = new Set([
            "archive",
            "archive_by_serial",
            "suspend",
            "suspend_by_serial",
            "place_on_market",
          ]);
          if (MOVED.has(action)) {
            return errorResult(
              `Unknown action "${action}" for tracepass_passports. Irreversible actions moved to tracepass_passport_lifecycle in 1.24.0.`,
            );
          }
          if (action === "record_registration" || action === "undo_registration") {
            return errorResult(
              `Unknown action "${action}" for tracepass_passports. ${action} is in tracepass_passport_lifecycle (it changes the passport's placement on the market).`,
            );
          }
          return errorResult(`Unknown action "${action}" for tracepass_passports.`);
        }
      }
    },
  };

  // ──────────────────────── passport fields ────────────────────
  const fieldsTool: McpToolDefinition = {
    name: "tracepass_passport_fields",
    title: "TracePass passport fields",
    description:
      "Update field values on a Digital Product Passport. Every change is audit-logged with the credential (API key or connected app) and this MCP channel.\n\n" +
      '`source` (optional): omit it or pass "manual" when the user gave you the value or it comes from their own records — written with the user\'s rights (approved for an API key or an admin; sent to review for a connected app acting for an editor). Pass "ai_suggested" when you found or inferred it yourself: it goes to the dashboard review queue for a human, and is refused on fields only the operator may state or that must be measured (e.g. stateOfHealth).\n\n' +
      "Actions (pass via `action`; `{…}` is the `args` object):\n- update — { id, fieldKey, value, source? }. `value` type matches the field's dataType.\n- update_by_serial — { serial, fieldKey, value, gtin?, source? }. On 409 ambiguous_serial (a serial is unique only WITHIN a GTIN) pass `gtin`.",
    inputSchema: {
      action: z.enum(["update", "update_by_serial"]),
      args: z
        .object({
          id: z.string().optional(),
          serial: z.string().optional(),
          gtin: z.string().optional(),
          fieldKey: z.string().optional(),
          value: z.unknown().optional(),
          source: FIELD_SOURCE.optional().describe(
            "manual (default) | ai_suggested (goes to human review).",
          ),
        })
        .partial()
        .optional(),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
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
          const p = parseArgs(
            SCHEMAS.fieldUpdateBySerial,
            a.args,
            "tracepass_passport_fields",
            action,
          );
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
      "Manage the economic-operator parties on a passport (manufacturer, importer, authorisedRepresentative, distributor, recycler, producerResponsibilityOrg). Each carries a legal name and an identifier.\n\n" +
      "A party needs at least one of `gln`, `legacyOperatorId` or `operatorIdentifier` (EN 18219 §6.2–6.5; they must agree if both gln forms are given, else 400). Identifier shapes: resource tracepass://reference/parties.\n\n" +
      "Actions (pass via `action`; `{…}` is the `args` object):\n- set — { id, role, legalName, gln?, country?, url?, tradeName?, postalAddress?, email?, legacyOperatorId?, operatorIdentifier?, facilityIdentifier? }. tradeName, postalAddress and email are public; for a battery importer they are its Battery Regulation Art. 41(3) details.\n- remove — { id, role }.\n\n" +
      "After a battery passport is placed on the market, changing a stored operatorIdentifier or facilityIdentifier returns 409 operator_locked; other edits stay allowed.",
    inputSchema: {
      action: z.enum(["set", "remove"]),
      args: z
        .object({
          id: z.string().optional(),
          role: z
            .string()
            .optional()
            .describe(
              "Economic-operator role: manufacturer | importer | authorisedRepresentative | distributor | recycler | producerResponsibilityOrg (required).",
            ),
          legalName: z.string().optional(),
          gln: z.string().optional().describe("13 digits."),
          country: z.string().optional().describe("ISO 3166-1 alpha-2."),
          url: z.string().optional(),
          tradeName: z.string().optional().describe("Max 200 chars. Public."),
          postalAddress: z.string().optional().describe("One line, max 500 chars. Public."),
          email: z.string().optional().describe("Company contact, not a person's. Public."),
          legacyOperatorId: z
            .string()
            .optional()
            .describe("Fallback identifier (VAT, EORI, supplier code)."),
          operatorIdentifier: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("{ scheme: iso6523|gln|did|doi, … }. Shapes: tracepass://reference/parties."),
          facilityIdentifier: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Same schemes as operatorIdentifier; gln also takes `extension`."),
        })
        .partial()
        .optional(),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
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
      "GS1 EPCIS 2.0 supply-chain events. `export`, `capture`, `capture_job` and `query` are on every plan, Free included. Captured events count against the plan's event allowance (10 a month on Free); over it `capture` returns an overage or hard-block message.\n\n" +
      "Actions (pass via `action`; `{…}` is the `args` object):\n- export, export_by_serial — { id } or { serial, gtin? } (on 409 ambiguous_serial pass `gtin`). A passport's events as an EPCIS 2.0 JSON-LD document. Read-only.\n- capture — { events }. An EPCISDocument, a single event, or an array of events (JSON-LD). Returns 202 with a captureJobId.\n- capture_job — { jobId }. Poll a capture job. Read-only.\n- query — { params? }. Standard EPCIS query parameters as key/value (EQ_bizStep, GE_eventTime, MATCH_epc, …). Read-only.",
    inputSchema: {
      action: z.enum(["export", "export_by_serial", "capture", "capture_job", "query"]),
      args: z
        .object({
          id: z.string().optional(),
          serial: z.string().optional(),
          gtin: z.string().optional(),
          events: z.unknown().optional(),
          jobId: z.string().optional(),
          params: z.record(z.string(), z.string()).optional(),
        })
        .partial()
        .optional(),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
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
            await client.get(
              `/api/v1/passports/by-serial/${seg(p.serial)}/epcis${qs({ gtin: p.gtin })}`,
            ),
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
          return apiResult(await client.get(`/api/v1/epcis/events${qs(p.params ?? {})}`));
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
      "What a COMPLIANT passport must contain per category, per the governing EU regulation. Read-only reference data; use it to advise on requirements before creating products/passports and to gap-check a draft.\n\n" +
      "Actions (pass via `action`; `{…}` is the `args` object):\n- list — {}. All 13 categories with counts and governing regulation.\n- get — { category }. Every field: key, label, dataType, REQUIRED flag, access level, options, bounds and, where known, the mandating article.\n\n" +
      "BATTERY — `required` alone is the wrong answer. SCOPE FIRST: only EV, LMT and industrial_gt_2kwh batteries owe a passport (Art. 77(1), Reg (EU) 2023/1542); for portable, SLI or industrial_lte_2kwh NO field is required — say it is out of scope and list no mandatory fields. Then use `requiredBy[batteryCategory]` (required | conditional | notApplicable), and `required` only as a fallback; skipping the scope step invents an obligation the Regulation does not impose. `conditional` fields, use data and the EV/LMT state-of-health split: resource tracepass://reference/templates.",
    inputSchema: {
      action: z.enum(["list", "get"]),
      args: z
        .object({
          category: z
            .string()
            .optional()
            .describe(
              "battery | textile | electronics | construction | steel | detergents | paints-coatings | packaging | furniture | tyres | jewelry | toys | fmcg.",
            ),
        })
        .partial()
        .optional(),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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

  // ───────────────────────────── scope ─────────────────────────
  // Scope is a genuinely new resource (the engine that answers "does
  // this product type need a DPP?"), so it earns its own tool rather
  // than being an action on an existing one (CLAUDE.md rule: scope is
  // a new resource, not a passport action).
  const scopeTool: McpToolDefinition = {
    name: "tracepass_scope",
    title: "TracePass DPP scope checker",
    description:
      "Check what EU law says for a product type matching the facts given: whether it needs a Digital Product Passport, from when, at which level, under which act and article, and the duties of each role. Also reads the catalogue-wide scope report and triggers a refresh run.\n\n" +
      "HARD RULES — always apply to scope answers:\n- State what the law says for product types matching the given facts. Not legal advice; never write 'you must' — use product-type phrasing ('LMT batteries need a passport from 18 February 2027, Battery Regulation Art. 77(1)').\n- Cite the article given for every verdict and duty; a regulation without an article is not a citation. `not_covered` rests on no article: say our rules do not cover the product, name the nearest act given, never cite it as the basis.\n- A date with precision 'quarter', 'month' or 'year' is a plan, NEVER a deadline: write 'planned for Q2 2027 (planned, not law yet)', never 'from', 'by' or 'deadline'.\n- Relay `not_covered` and `needs_input` as results, never errors. `needs_input` = blocking questions remain — relay `ask[]` to the user before giving a verdict.\n- Items in an act's `planned` list are not law yet: label them 'Planned, not law yet' (`labelText`), with their `wording`.\n- `data.inScope`: yes = passport required; no = none required AND none planned (incl. ESPR-framework-only products, packaging): never say 'not yet' or 'yet'; pending = none today, a passport act is planned: name it from `planned[]`; depends = unanswered facts.\n- `ruleStatus: 'needs_recheck'`: the law behind the act changed and our rules are being re-checked (since `recheckSince`); say so.\n\n" +
      "Actions (pass via `action`; `{…}` is the `args` object); values, caps and response shapes: resource tracepass://reference/scope.\n- check — { category?, facts?, role?, placedOnMarket?, lifecycleEvent?, contains?, productId?, passportId?, locale? }. Every plan; counts against the scope-answer cap (~100/day), not the v1 budget (429 `scope_answer_cap`). Unknown `facts` keys: 400. Omit `role` for all roles' duties.\n- catalogue_report — { classification?, category?, act?, changed?, q?, cursor?, limit? (≤500) }. One row per product. Growth plan or above; 403 `plan_upgrade_required` below it — tell the user this needs a plan upgrade, do not retry.\n- catalogue_run — {}. Start a refresh run (also nightly); poll with catalogue_run_status. Growth plan. 409 run_in_progress; 429 run_cooldown.\n- catalogue_run_status — { runId }. Growth plan.",
    inputSchema: {
      action: z.enum(["check", "catalogue_report", "catalogue_run", "catalogue_run_status"]),
      args: z
        .object({
          // check
          category: z
            .string()
            .optional()
            .describe("Product category (values: tracepass://reference/scope)."),
          facts: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Namespaced fact keys, e.g. { 'battery.use': 'ev' }."),
          role: z
            .string()
            .optional()
            .describe(
              "manufacturer | importer | distributor | authorised_representative | fulfilment_service_provider.",
            ),
          placedOnMarket: z
            .object({ date: z.string(), precision: z.string().optional() })
            .nullable()
            .optional()
            .describe("{ date: YYYY[-MM[-DD]], precision?: day|month|year } or null."),
          lifecycleEvent: z.string().nullable().optional(),
          contains: z
            .array(
              z.object({
                label: z.string().optional(),
                facts: z.record(z.string(), z.unknown()).optional(),
              }),
            )
            .optional(),
          productId: z.string().nullable().optional().describe("Adds saved product facts."),
          passportId: z.string().nullable().optional().describe("Adds saved passport facts."),
          locale: z.string().optional(),
          // catalogue_report
          classification: z.string().optional(),
          act: z.string().optional().describe("CELEX, e.g. 32023R1542."),
          changed: z.boolean().optional(),
          q: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.number().optional(),
          // catalogue_run_status
          runId: z.string().optional(),
        })
        .partial()
        .optional(),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "check": {
          const p = parseArgs(SCHEMAS.scopeCheck, a.args, "tracepass_scope", action);
          if (isErr(p)) return p;
          const res = await client.post("/api/v1/scope/check", p);
          // Handle scope-specific 429: scope_answer_cap (the per-company daily
          // cap, ~100/day) is different from the v1 daily read/write budget.
          if (!res.ok && res.status === 429) {
            const b = (res.body ?? {}) as Record<string, unknown>;
            if (b.error === "scope_answer_cap") {
              const limit = textOf(b.limit);
              const resetAt = typeof b.resetAt === "string" ? b.resetAt : undefined;
              return errorResult(
                `Scope check limit reached${limit !== undefined ? ` (${limit} per day per account)` : ""}.` +
                  (resetAt ? ` Resets at ${resetAt}.` : " Retry later."),
              );
            }
          }
          return apiResult(res);
        }
        case "catalogue_report": {
          const p = parseArgs(SCHEMAS.catalogueReport, a.args, "tracepass_scope", action);
          if (isErr(p)) return p;
          const { changed, ...rest } = p;
          const params: Record<string, string | number | boolean | undefined> = { ...rest };
          if (changed !== undefined) params.changed = changed ? "true" : undefined;
          return apiResult(await client.get(`/api/v1/scope/catalogue${qs(params)}`));
        }
        case "catalogue_run": {
          parseArgs(SCHEMAS.catalogueRun, a.args ?? {}, "tracepass_scope", action);
          const runRes = await client.post("/api/v1/scope/catalogue/runs");
          // run_cooldown (429): a run finished within the last 10 min — surface the existing run rather than a generic "budget" message.
          // run_in_progress (409): already active — relay the existing run id.
          if (!runRes.ok && (runRes.status === 429 || runRes.status === 409)) {
            const rb = (runRes.body ?? {}) as Record<string, unknown>;
            const code = typeof rb.error === "string" ? rb.error : undefined;
            if (code === "run_cooldown" || code === "run_in_progress") {
              const existingRun = (rb.run ?? {}) as Record<string, unknown>;
              const retryAfter =
                code === "run_cooldown" && typeof rb.retryAfter === "number"
                  ? ` Retry in ${String(rb.retryAfter)} seconds.`
                  : "";
              const runId = textOf(existingRun.id);
              const runInfo = runId
                ? ` Existing run id: ${runId} (status: ${textOf(existingRun.status) ?? "unknown"}).`
                : "";
              return errorResult(
                `Catalogue run ${code === "run_cooldown" ? "cooldown" : "already in progress"}.${runInfo}${retryAfter}`,
              );
            }
          }
          return apiResult(runRes);
        }
        case "catalogue_run_status": {
          const p = parseArgs(SCHEMAS.catalogueRunStatus, a.args, "tracepass_scope", action);
          if (isErr(p)) return p;
          return apiResult(await client.get(`/api/v1/scope/catalogue/runs/${seg(p.runId)}`));
        }
        default:
          return errorResult(`Unknown action "${action}" for tracepass_scope.`);
      }
    },
  };

  // ──────────────────── passport lifecycle ─────────────────────
  // SEC-37: irreversible / public-facing actions separated so a
  // client's "Always allow" on reading does not also allow them.
  const lifecycleTool: McpToolDefinition = {
    name: "tracepass_passport_lifecycle",
    title: "TracePass passport lifecycle (irreversible actions)",
    description:
      "WARNING: Every action here changes what the public sees or is a legal act, some irreversible. `archive` permanently takes the passport off public view (its URL shows an archive notice; only an authority access grant still reads it). `record_registration` records the economic operator's registration in the production EU DPP Registry and locks the passport's operator and facility identifiers. `place_on_market` submits a registration to an EN 18222 registry API. The assistant MUST confirm with the user before each call. Use `suspend` (reversible — public QR shows 'suspended') as the safe alternative to archive when a change might need to be undone; a passport placed on the market cannot be suspended, because it must stay public.\n\n" +
      "EU DPP REGISTRY: the operator registers a battery passport itself, on the Registry website under its own EU Login; TracePass never submits to the Registry and never verifies the outcome. The acceptance environment has no legal effect; only a production registration counts. Paid plan; a connected app (OAuth) must act for an admin or owner. Refusal codes: resource tracepass://reference/lifecycle.\n\n" +
      "Actions (pass via `action`; `{…}` is the `args` object). All are WRITEs (1 write each). A *_by_serial action takes { serial, gtin? } instead of `id` (on 409 ambiguous_serial pass `gtin`).\n- record_registration — { id, placedOnMarketAt? (YYYY-MM-DD), registrationId? }. Battery, published only. Records that the operator has registered this passport in the PRODUCTION EU DPP Registry, as the operator states it; TracePass does not check it. Confirm with the user first, and only after the operator has registered on the Registry website. Effects: marked placed on the market; operator and facility identifiers locked (409 operator_locked); webhook fires.\n- undo_registration — { id, environment: production|acceptance }. Undoes a mistaken record; production unlocks the operator identifiers (a delivered webhook is not recalled). Changes nothing in the Registry. Confirm with the user first.\n- place_on_market — { id }. Battery, published only. Submits to the EN 18222 registry API in the account's registry settings. NOT the way into the EU DPP Registry, which does not accept it: use prepare_registry_upi / prepare_registry_upload_file, then record_registration. A legal act for the economic operator — confirm with the user first. ASYNCHRONOUS: answers 202 \"placing\"; follow placeOnMarketStatus (placing → placed | rejected) by reading the passport. 409 codes include registry_host_not_allowed (the configured registry address is not allowed; check the URL) and registry_not_ready (run registry_readiness).\n- suspend, suspend_by_serial — { id }. Reversible — public QR shows 'suspended'. Refused with 409 passport_placed_on_market once the passport is placed on the market or its registration is under way.\n- archive, archive_by_serial — { id, reason? }. IRREVERSIBLE and destructive — confirm with the user first. Its URL then shows an archive notice (machine formats 404); only an authority grant still reads it. reason is REQUIRED for battery passports (400 reason_required): recycled, never_placed (never placed on the market or put into service) or duplicate_or_error; never_placed is refused (409 reason_contradicts_placement) once placed on the market.\n- archive_product — { id }. Archives a PRODUCT (not a passport). Reversible — soft-archives it from the catalogue. 409 while any non-archived passport references it; archive those first.",
    inputSchema: {
      action: z
        .enum([
          "record_registration",
          "undo_registration",
          "place_on_market",
          "suspend",
          "suspend_by_serial",
          "archive",
          "archive_by_serial",
          "archive_product",
        ])
        .describe(
          "All actions require user confirmation. archive is IRREVERSIBLE (public URL becomes an archive notice); suspend is reversible.",
        ),
      args: z
        .object({
          id: z.string().optional(),
          placedOnMarketAt: z.string().optional(),
          registrationId: z.string().optional(),
          environment: z.enum(["production", "acceptance"]).optional(),
          serial: z.string().optional(),
          gtin: z.string().optional(),
          reason: ARCHIVE_REASON.optional().describe("Required for battery passports."),
        })
        .partial()
        .optional(),
    },
    outputSchema: API_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (a) => {
      const action = String(a.action);
      switch (action) {
        case "record_registration": {
          const p = parseArgs(
            SCHEMAS.registryRegistration,
            a.args,
            "tracepass_passport_lifecycle",
            action,
          );
          if (isErr(p)) return p;
          const body: Record<string, unknown> = { environment: "production" };
          if (p.placedOnMarketAt !== undefined) body.placedOnMarketAt = p.placedOnMarketAt;
          if (p.registrationId !== undefined) body.registrationId = p.registrationId;
          return apiResult(await client.post(`/api/v1/passports/${seg(p.id)}/registration`, body));
        }
        case "undo_registration": {
          const p = parseArgs(
            SCHEMAS.registryRegistrationUndo,
            a.args,
            "tracepass_passport_lifecycle",
            action,
          );
          if (isErr(p)) return p;
          return apiResult(
            await client.delete(
              `/api/v1/passports/${seg(p.id)}/registration${qs({ environment: p.environment })}`,
            ),
          );
        }
        case "place_on_market": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passport_lifecycle", action);
          if (isErr(p)) return p;
          return apiResult(await client.post(`/api/v1/passports/${seg(p.id)}/place-on-market`));
        }
        case "suspend": {
          const p = parseArgs(SCHEMAS.passportId, a.args, "tracepass_passport_lifecycle", action);
          if (isErr(p)) return p;
          return apiResult(await client.post(`/api/v1/passports/${seg(p.id)}/suspend`));
        }
        case "suspend_by_serial": {
          const p = parseArgs(
            SCHEMAS.passportSerial,
            a.args,
            "tracepass_passport_lifecycle",
            action,
          );
          if (isErr(p)) return p;
          return apiResult(
            await client.post(
              `/api/v1/passports/by-serial/${seg(p.serial)}/suspend${qs({ gtin: p.gtin })}`,
            ),
          );
        }
        case "archive": {
          const p = parseArgs(
            SCHEMAS.passportArchive,
            a.args,
            "tracepass_passport_lifecycle",
            action,
          );
          if (isErr(p)) return p;
          return apiResult(
            await client.post(`/api/v1/passports/${seg(p.id)}/archive`, archiveBody(p.reason)),
          );
        }
        case "archive_by_serial": {
          const p = parseArgs(
            SCHEMAS.passportArchiveBySerial,
            a.args,
            "tracepass_passport_lifecycle",
            action,
          );
          if (isErr(p)) return p;
          return apiResult(
            await client.post(
              `/api/v1/passports/by-serial/${seg(p.serial)}/archive${qs({ gtin: p.gtin })}`,
              archiveBody(p.reason),
            ),
          );
        }
        case "archive_product": {
          const p = parseArgs(
            SCHEMAS.productArchive,
            a.args,
            "tracepass_passport_lifecycle",
            action,
          );
          if (isErr(p)) return p;
          return apiResult(await client.post(`/api/v1/products/${seg(p.id)}/archive`));
        }
        default:
          if (
            action === "prepare_registry_upi" ||
            action === "prepare_registry_upload_file" ||
            action === "record_acceptance_test"
          ) {
            return errorResult(
              `Unknown action "${action}" for tracepass_passport_lifecycle. ${action} is in tracepass_passports.`,
            );
          }
          return errorResult(`Unknown action "${action}" for tracepass_passport_lifecycle.`);
      }
    },
  };

  return [
    productsTool,
    passportsTool,
    fieldsTool,
    partiesTool,
    epcisTool,
    templatesTool,
    scopeTool,
    lifecycleTool,
  ];
}
