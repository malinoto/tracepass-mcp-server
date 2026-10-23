/**
 * The COMPLIANCE MCP server — the DPP Assistant's in-house endpoint.
 *
 * Served at `/compliance/mcp`. Answers EU Digital Product Passport scope,
 * field, registry and change questions through nine small, single-purpose
 * tools. Unlike the action-based tools on /mcp ("one tool, many actions"),
 * here each tool answers exactly one kind of question — the simpler surface
 * makes tool selection more accurate for the model.
 *
 * Auth: SAME as /mcp — OAuth 2.0 or a tp_ API key forwarded to the platform.
 * The compliance endpoint DOES have an auth gate and a WWW-Authenticate
 * challenge, unlike the supplier endpoint (suppliers have no account). Its
 * challenge points to a per-path protected-resource metadata document at
 * /.well-known/oauth-protected-resource/compliance/mcp, whose `resource`
 * is exactly `https://ai.tracepass.eu/compliance/mcp`.
 *
 * Channel: every platform call carries `X-Source: assistant` (not "mcp") so
 * the platform logs answers under channel "assistant" and applies the
 * assistant-channel account gate (email verified, not a disposable domain).
 *
 * Nine tools:
 *   scope_check          — is a passport required? (read-only POST)
 *   required_fields      — which data must the passport hold?
 *   what_changed         — what has changed in EU law for these categories?
 *   registry_guidance    — identifiers, carriers, formats, registration
 *   create_draft_passport — hand-off: create a draft passport in TracePass
 *   report_answer        — flag a wrong or unclear answer
 *   get_profile          — read stored company facts
 *   update_profile       — save or correct company facts
 *   delete_profile       — remove all stored company facts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TracePassClient } from "./api-client.js";
import { MCP_SERVER_INFO } from "./server.js";
import { errorResult, inactiveAccountMessage, jsonResult, type ToolResult } from "./result.js";
import type { ToolAnnotations } from "./tools.js";

/** Source tag for all platform calls from the compliance channel. */
const COMPLIANCE_SOURCE = "assistant";

export const COMPLIANCE_SERVER_INFO = {
  name: "tracepass-compliance",
  version: MCP_SERVER_INFO.version,
} as const;

export interface CreateComplianceMcpServerConfig {
  baseUrl: string;
  /** The caller's bearer token — a tp_ API key or an OAuth access token.
   *  Forwarded verbatim to the v1 API, which decides validity. */
  apiKey: string;
}

/** The public dashboard origin, for the passport link returned by create_draft_passport. */
const DASHBOARD_ORIGIN = "https://app.tracepass.eu";

// ---------------------------------------------------------------------------
// Error mapping — compliance-server flavour
// ---------------------------------------------------------------------------

/**
 * Add the envelope's disclaimer as its own closing instruction. Left inside the
 * JSON, models drop it from most answers; a separate line next to the data is
 * what they keep.
 */
export function withClosingDisclaimer(result: ToolResult, body: unknown): ToolResult {
  const disclaimer =
    body && typeof body === "object" ? (body as Record<string, unknown>).disclaimer : undefined;
  if (typeof disclaimer !== "string" || disclaimer.trim() === "") return result;
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text", text: `End your answer with this line, word for word:\n${disclaimer}` },
    ],
  };
}

/**
 * Turn a platform response into a ToolResult for the compliance channel.
 *
 * The compliance channel adds two 403 sub-cases (account gate) and the
 * 429 scope_answer_cap. Everything else falls through to the generic
 * cases.
 */
export function complianceResult(res: { status: number; ok: boolean; body: unknown }): ToolResult {
  if (res.ok) return withClosingDisclaimer(jsonResult(res.body), res.body);
  const body = (res.body ?? {}) as Record<string, unknown>;
  const errorCode = typeof body.error === "string" ? body.error : undefined;
  const message = typeof body.message === "string" ? body.message : undefined;

  // 403 account_not_eligible (assistant channel only): email not verified or
  // disposable domain. The reason is the decisive field; message is supplementary.
  if (res.status === 403 && errorCode === "account_not_eligible") {
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (reason === "email_not_verified") {
      return errorResult(
        "Your email address is not verified. Please verify it in your TracePass account settings before using the DPP Assistant.",
      );
    }
    if (reason === "disposable_email") {
      return errorResult(
        "This service is not available with a disposable email address. Please log in with your work or permanent email.",
      );
    }
    return errorResult(`Account not eligible: ${reason || message || "contact support@tracepass.eu."}`);
  }

  // 429 scope_answer_cap: the per-company daily answer cap is exhausted.
  // Every assistant read counts one answer on the shared counter.
  if (res.status === 429 && errorCode === "scope_answer_cap") {
    const limit = typeof body.limit === "number" ? `${body.limit}` : "the daily";
    const resetAt = typeof body.resetAt === "string" ? body.resetAt : "00:00 UTC tomorrow";
    return errorResult(
      `Daily answer limit reached (${limit} answers). The limit resets at ${resetAt}. Please try again then.`,
    );
  }

  // 400 invalid input: surface the platform's message, and the allowed values if present.
  if (res.status === 400) {
    const allowed = Array.isArray(body.allowed) ? (body.allowed as unknown[]).map(String) : null;
    const suffix = allowed ? ` Allowed values: ${allowed.join(", ")}.` : "";
    return errorResult(`Invalid input: ${message ?? "check the tool arguments."}${suffix}`);
  }

  // 401 auth: credential missing or rejected.
  if (res.status === 401) {
    return errorResult(
      "Authentication failed — the TracePass credential is missing or invalid. Check the API key or re-authorise the assistant.",
    );
  }

  // 402 (create_draft_passport): the subscription is past due. A draft
  // takes no plan slot, so creating one never hits the plan limit.
  if (res.status === 402) {
    return errorResult(
      `Payment required: ${message ?? "the account's subscription is past due."}` +
        " Tell the user to resolve billing in TracePass before creating more drafts.",
    );
  }

  // 403 plan-gated (all other 403 codes, not account_not_eligible), unless it
  // is about the account's state (inactive subscription, API access off).
  if (res.status === 403) {
    const inactive = inactiveAccountMessage(errorCode);
    if (inactive) return errorResult(inactive);
    return errorResult(
      `Not permitted on this account's plan${errorCode ? ` (${errorCode})` : ""}.` +
        ` ${message ?? "This feature may require a higher plan or a paid add-on."}` +
        " Do not retry — tell the user this needs a plan change.",
    );
  }

  // 409 conflict: product model name already exists in this company's catalogue.
  if (res.status === 409) {
    return errorResult(
      `Conflict: ${message ?? "a product with this name already exists. Use a different product name or open the existing product in TracePass."}`,
    );
  }

  // Generic fallback.
  return errorResult(
    `TracePass returned ${res.status}. ${message ?? errorCode ?? JSON.stringify(res.body)}`,
  );
}

// ---------------------------------------------------------------------------
// The categories /api/v1/scope/check accepts
// ---------------------------------------------------------------------------

/**
 * The endpoint's request schema is strict: any other category is 400
 * invalid_input. Declared as an enum so the model picks a key instead of
 * passing the user's words ("lamps", "paint"). Pinned to the published
 * OpenAPI enum by tests/compliance-server.test.ts.
 */
export const SCOPE_CATEGORIES = [
  "battery",
  "construction",
  "detergents",
  "electronics",
  "fmcg",
  "furniture",
  "jewelry",
  "packaging",
  "paints-coatings",
  "steel",
  "textile",
  "toys",
  "tyres",
  "vehicles",
  "other",
] as const;

/**
 * The categories with a passport template: what /api/v1/regulatory/required-fields
 * and /api/v1/products accept (an unknown one is a 400). No "vehicles" or
 * "other": neither has a template. Pinned to the platform's templates/ folder
 * by tests/compliance-server.test.ts.
 */
export const TEMPLATE_CATEGORIES = [
  "battery",
  "construction",
  "detergents",
  "electronics",
  "fmcg",
  "furniture",
  "jewelry",
  "packaging",
  "paints-coatings",
  "steel",
  "textile",
  "toys",
  "tyres",
] as const;

const TEMPLATE_CATEGORY_HINT =
  "Product category key, one of the listed values. Map the user's product to the closest key (paint → paints-coatings, an e-bike battery → battery). Never pass the user's own words. If none fits, there is no passport template for it: say so instead of calling.";

// ---------------------------------------------------------------------------
// Hard-rule block appended to every tool description (draft C)
// ---------------------------------------------------------------------------

const HARD_RULES =
  " Use only what this tool returns: add no facts, dates or articles of your own, not even today's date. Keep every citation and the disclaimer line, and any \"Planned, not law yet\" or \"being re-checked\" label. Phrase answers about the product type, never as personal duties (\"you must\"). Never rank or recommend vendors. Never call this advice or yourself a consultant. If the result is not_covered, say so and point to the article given.";

// ---------------------------------------------------------------------------
// Tool interface (same pattern as supplier-server.ts)
// ---------------------------------------------------------------------------

interface ComplianceTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Build the nine compliance tools bound to a client. */
export function buildComplianceTools(client: TracePassClient): ComplianceTool[] {
  return [
    // -------------------------------------------------------------------------
    // 1. scope_check
    //
    // Annotation: readOnlyHint=true even though the platform route is a POST.
    // The POST is stateless — it takes facts in the request body and returns a
    // scope verdict; it writes nothing to the database. The read-only hint
    // describes the tool's effect on the account, not the HTTP method.
    // -------------------------------------------------------------------------
    {
      name: "scope_check",
      title: "Check if a product needs a passport",
      description:
        "Checks whether EU law requires a Digital Product Passport for a type of product, from when, and what the law requires of each role. Use it for \"do I need a passport\", \"from when\", \"who is responsible\", whether that responsibility can be handed to another company, who keeps and stores the passport and whether it must stay available after the company ceases, whether there is one passport per item, batch or model, and for repurposing, remanufacturing, waste or a battery inside another product. Pass whatever facts the user gave; if the result is needs_input, ask the user its questions in plain words and call again. The result's data.inScope is one of: yes, no, pending, depends." +
        HARD_RULES,
      inputSchema: {
        category: z
          .enum(SCOPE_CATEGORIES)
          .optional()
          .describe(
            "Product category key, one of the listed values. Map the user's product to the closest key (paint → paints-coatings, an e-bike battery → battery); use \"other\" when no key fits. Never pass the user's own words.",
          ),
        role: z
          .string()
          .max(120)
          .optional()
          .describe(
            "The user's role in plain words, e.g. \"maker\", \"importer\", \"reseller\". The platform maps this to the act's term.",
          ),
        placedOnMarket: z
          .object({
            date: z.string().describe("ISO date or partial date, e.g. \"2027-02\" or \"2027\"."),
            precision: z.enum(["day", "month", "year"]).optional(),
          })
          .optional()
          .describe("When the product was or will be placed on the market."),
        facts: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Product facts the scope rules declare, e.g. {\"battery.capacityKWh\": 10}. Any other key is rejected, so pass only a fact you know the rules use (such as one a needs_input result asked for), and never the user's question or free text.",
          ),
        locale: z
          .enum(["en", "bg", "de", "it"])
          .optional()
          .describe("Language for the answer text. Defaults to en."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) =>
        complianceResult(
          await client.post("/api/v1/scope/check", {
            ...(args.category ? { category: args.category } : {}),
            ...(args.role ? { role: args.role } : {}),
            ...(args.placedOnMarket ? { placedOnMarket: args.placedOnMarket } : {}),
            ...(args.facts ? { facts: args.facts } : {}),
            ...(args.locale ? { locale: args.locale } : {}),
          }),
        ),
    },

    // -------------------------------------------------------------------------
    // 2. required_fields
    // -------------------------------------------------------------------------
    {
      name: "required_fields",
      title: "List required passport fields",
      description:
        "Lists the data a passport must contain for a product category, with the article requiring each field, who may see it, how often it changes, and whether it usually comes from the maker or a supplier. Call it without `group` for a summary (counts by group), then with a `group` for the fields." +
        HARD_RULES,
      inputSchema: {
        category: z.enum(TEMPLATE_CATEGORIES).describe(TEMPLATE_CATEGORY_HINT),
        subType: z
          .string()
          .max(100)
          .optional()
          .describe("Battery only: EV, LMT or industrial_gt_2kwh (an industrial battery over 2 kWh). Narrows the required fields to that battery type; an unknown value is refused with the allowed list."),
        group: z
          .string()
          .max(100)
          .optional()
          .describe("Template group name. Omit for a summary; provide to list the fields."),
        locale: z
          .enum(["en", "bg", "de", "it"])
          .optional()
          .describe("Language for field labels and descriptions. Defaults to en."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        const qs = new URLSearchParams();
        if (typeof args.category === "string") qs.set("category", args.category);
        if (typeof args.subType === "string") qs.set("subType", args.subType);
        if (typeof args.group === "string") qs.set("group", args.group);
        if (typeof args.locale === "string") qs.set("locale", args.locale);
        return complianceResult(await client.get(`/api/v1/regulatory/required-fields?${qs.toString()}`));
      },
    },

    // -------------------------------------------------------------------------
    // 3. what_changed
    //
    // Annotation: readOnlyHint=true. The "last asked" date is READ from the call
    // log, not written. The call log already exists for the daily cap; this tool
    // stores no additional state of its own.
    // -------------------------------------------------------------------------
    {
      name: "what_changed",
      title: "What changed in EU passport law",
      description:
        "Reports changes in EU passport law and standards for the user's categories since a date (default: since they last asked). Use it for \"what's new\" or \"has X been adopted\". Items marked \"Planned, not law yet\" are upcoming obligations, not yet in force." +
        HARD_RULES,
      inputSchema: {
        categories: z
          .array(z.string().max(100))
          .optional()
          .describe("Product categories to filter by. Defaults to the saved profile categories."),
        since: z
          .string()
          .optional()
          .describe(
            "ISO date to look back from. Defaults to the date this account last called what_changed (first time: 90 days ago).",
          ),
        locale: z
          .enum(["en", "bg", "de", "it"])
          .optional()
          .describe("Language for summaries. Defaults to en."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        const qs = new URLSearchParams();
        if (Array.isArray(args.categories)) qs.set("categories", (args.categories as string[]).join(","));
        if (typeof args.since === "string") qs.set("since", args.since);
        if (typeof args.locale === "string") qs.set("locale", args.locale);
        return complianceResult(await client.get(`/api/v1/regulatory/changes?${qs.toString()}`));
      },
    },

    // -------------------------------------------------------------------------
    // 4. registry_guidance
    // -------------------------------------------------------------------------
    {
      name: "registry_guidance",
      title: "EU DPP Registry guidance",
      description:
        "Explains the EU DPP Registry and the technical side: registration in the registry, identifiers, QR and data carriers, data formats (JSON, HTML, data models) and standards, and where passport data is kept. Each point carries the date of its source. For who owes, keeps or may hand off a passport, use scope_check." +
        HARD_RULES,
      inputSchema: {
        topic: z
          .enum(["registration", "identifiers", "data_carrier", "data_format", "standards", "where_created", "access"])
          .describe("The topic to answer."),
        category: z
          .string()
          .max(100)
          .optional()
          .describe("Optional category filter (e.g. battery) for category-specific guidance."),
        locale: z
          .enum(["en", "bg", "de", "it"])
          .optional()
          .describe("Language for the answer. Defaults to en."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        const qs = new URLSearchParams();
        if (typeof args.topic === "string") qs.set("topic", args.topic);
        if (typeof args.category === "string") qs.set("category", args.category);
        if (typeof args.locale === "string") qs.set("locale", args.locale);
        return complianceResult(await client.get(`/api/v1/regulatory/registry-guidance?${qs.toString()}`));
      },
    },

    // -------------------------------------------------------------------------
    // 5. create_draft_passport
    //
    // Two-step: POST /api/v1/products then POST /api/v1/passports (draft).
    // Never invents a GTIN — if the identifier is absent, returns a needs_input
    // result asking for it. Publishing is always done by the user in TracePass.
    // -------------------------------------------------------------------------
    {
      name: "create_draft_passport",
      title: "Create a draft passport",
      description:
        "Creates a **draft** passport in the user's own TracePass account from facts they stated. Use it whenever the user asks to create a passport, including \"create and publish\": create the draft, then say that publishing is done by the user in TracePass. It never publishes. If the result asks for an identifier, ask the user; never invent one." +
        HARD_RULES,
      inputSchema: {
        category: z.enum(TEMPLATE_CATEGORIES).describe(TEMPLATE_CATEGORY_HINT),
        productName: z.string().min(1).max(255).describe("The product's name."),
        gtin: z
          .string()
          .max(20)
          .optional()
          .describe(
            "The product's GTIN (barcode number, 8–14 digits). Required for most passport types. If missing, the tool will ask the user for it.",
          ),
        serialNumber: z
          .string()
          .max(100)
          .optional()
          .describe("The specific unit's serial number, if the passport is per-unit."),
        subType: z
          .string()
          .max(100)
          .optional()
          .describe("Battery only: EV, LMT or industrial_gt_2kwh. Used to count the required fields for that battery type; ask the user rather than guess."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => {
        // Never invent a GTIN or a serial number — ask the user for both if missing.
        const hasGtin = args.gtin && String(args.gtin).trim() !== "";
        const hasSerial = args.serialNumber && String(args.serialNumber).trim() !== "";

        if (!hasGtin) {
          return jsonResult({
            status: "needs_input",
            answer:
              "To create a draft passport I need the product's GTIN (the barcode number — 8, 12, 13 or 14 digits) and the unit's serial number. You'll find the GTIN on the physical barcode or the product's datasheet; the serial number is on the product label or the manufacturer's documentation.",
            ask: [
              { fact: "gtin", question: "What is the product's GTIN (barcode number)?" },
              { fact: "serialNumber", question: "What is the unit's serial number?" },
            ],
          });
        }
        if (!hasSerial) {
          return jsonResult({
            status: "needs_input",
            answer:
              "I also need the unit's serial number to create the passport (required alongside the GTIN). You'll find it on the product label or in the manufacturer's documentation.",
            ask: [{ fact: "serialNumber", question: "What is the unit's serial number?" }],
          });
        }

        const category = typeof args.category === "string" ? args.category : "";
        const productName = typeof args.productName === "string" ? args.productName : "";

        // Step 1: create the product.
        // `model` is a required unique key per company; reuse productName as the model
        // value (unique within the company's catalogue).
        const productBody: Record<string, unknown> = { name: productName, model: productName, category };
        const productRes = await client.post("/api/v1/products", productBody);
        if (!productRes.ok) return complianceResult(productRes);
        const productData = (productRes.body ?? {}) as Record<string, unknown>;
        // Platform returns `_id` (Mongo ObjectId string), not `id`.
        const productId =
          typeof productData._id === "string" ? productData._id : String(productData._id ?? "");

        // Step 2: create the draft passport.
        // GS1 identifiers must be nested under `gs1: {}`, not at the top level.
        const gs1: Record<string, string> = { gtin: String(args.gtin) };
        if (args.serialNumber) gs1.serialNumber = String(args.serialNumber);
        const passportBody: Record<string, unknown> = { productId, gs1 };
        const passportRes = await client.post("/api/v1/passports", passportBody);
        if (!passportRes.ok) return complianceResult(passportRes);
        const passportData = (passportRes.body ?? {}) as Record<string, unknown>;
        // Platform returns `_id`, not `id`.
        const passportId =
          typeof passportData._id === "string" ? passportData._id : String(passportData._id ?? "");

        // Step 3: check how many required fields are still missing.
        // GET /api/v1/passports/{id}/compliance returns ComplianceResult (NOT the
        // standard envelope). Count distinct `target` values of `critical` items
        // whose type is "missing_field" or "conditional_missing" for stillRequired;
        // count "missing_party" items for missingParties.
        let stillRequired: number | null = null;
        let missingParties: number | null = null;
        let missingTargets: Set<string> | null = null;
        const complianceRes = await client.get(`/api/v1/passports/${encodeURIComponent(passportId)}/compliance`);
        if (complianceRes.ok) {
          const compData = (complianceRes.body ?? {}) as Record<string, unknown>;
          const critical = Array.isArray(compData.critical)
            ? (compData.critical as Array<{ type?: string; target?: string }>)
            : [];
          const missingFieldTargets = new Set(
            critical
              .filter((c) => c.type === "missing_field" || c.type === "conditional_missing")
              .map((c) => c.target)
              .filter((t): t is string => typeof t === "string"),
          );
          stillRequired = missingFieldTargets.size;
          missingTargets = missingFieldTargets;
          missingParties = critical.filter((c) => c.type === "missing_party").length;
        }

        // Step 4 (battery only): get maker/supplier split from required_fields.
        // GET /api/v1/regulatory/required-fields?category=battery returns the
        // envelope with data.summary.requiredByHolder.{maker,supplier,either,operator}
        // as arrays of field key strings. makerOrSupplierCount = distinct missing
        // targets that appear in maker ∪ supplier ∪ either (operator never counts).
        let makerOrSupplierCount: number | null = null;
        if (category.toLowerCase() === "battery") {
          const rfRes = await client.get(
            `/api/v1/regulatory/required-fields?category=battery${args.subType ? `&subType=${encodeURIComponent(String(args.subType))}` : ""}`,
          );
          if (rfRes.ok) {
            const rfData = (rfRes.body ?? {}) as Record<string, unknown>;
            const summary = (
              (rfData.data as Record<string, unknown> | undefined)?.summary as Record<string, unknown> | undefined
            );
            const byHolder = summary?.requiredByHolder as Record<string, unknown> | undefined;
            if (byHolder && missingTargets) {
              const maker = Array.isArray(byHolder.maker) ? (byHolder.maker as string[]) : [];
              const supplier = Array.isArray(byHolder.supplier) ? (byHolder.supplier as string[]) : [];
              const either = Array.isArray(byHolder.either) ? (byHolder.either as string[]) : [];
              const holderKeys = new Set([...maker, ...supplier, ...either]);
              makerOrSupplierCount = [...missingTargets].filter((t) => holderKeys.has(t)).length;
            }
          }
        }

        const dashboardUrl = `${DASHBOARD_ORIGIN}/passports/${passportId}`;
        return jsonResult({
          status: "answered",
          passportId,
          dashboardUrl,
          ...(stillRequired !== null ? { stillRequired } : {}),
          ...(missingParties !== null && missingParties > 0 ? { missingParties } : {}),
          ...(makerOrSupplierCount !== null ? { makerOrSupplierCount } : {}),
          answer:
            `Draft passport created. Open it in TracePass to complete the required fields: ${dashboardUrl}` +
            (stillRequired !== null ? ` (${stillRequired} required field${stillRequired === 1 ? "" : "s"} still to fill)` : "") +
            ". Publishing is done by you in TracePass; I never publish.",
        });
      },
    },

    // -------------------------------------------------------------------------
    // 6. report_answer
    //
    // Annotation: readOnlyHint=false, idempotentHint=false — adds a report to the
    // review queue, which is a durable write (unlike scope_check which is a
    // stateless POST).
    // -------------------------------------------------------------------------
    {
      name: "report_answer",
      title: "Report a wrong or unclear answer",
      description:
        "Use it when the user says an answer was wrong or unclear. Pass their words and the `ruleIds` of the answer. The report goes to a review queue." +
        HARD_RULES,
      inputSchema: {
        what: z
          .string()
          .min(1)
          .max(2000)
          .describe("The user's own words describing what was wrong or unclear."),
        ruleIds: z
          .array(z.string())
          .optional()
          .describe("The ruleIds from the answer that was reported. Pass them from the result unchanged."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) =>
        complianceResult(
          await client.post("/api/v1/scope/reports", {
            what: args.what,
            ...(args.ruleIds ? { ruleIds: args.ruleIds } : {}),
            channel: "assistant",
          }),
        ),
    },

    // -------------------------------------------------------------------------
    // 7. get_profile
    // -------------------------------------------------------------------------
    {
      name: "get_profile",
      title: "Read stored company facts",
      description:
        "Shows the company facts the assistant has stored (categories, markets, role, own-brand flag, etc.) and when they were last updated." +
        HARD_RULES,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async () => complianceResult(await client.get("/api/v1/company/compliance-profile")),
    },

    // -------------------------------------------------------------------------
    // 8. update_profile
    //
    // Annotation: destructiveHint=true — a correction overwrites a stored fact.
    // -------------------------------------------------------------------------
    {
      name: "update_profile",
      title: "Save or correct company facts",
      description:
        "Saves or corrects company facts. Use it when the user states a lasting fact about their company (role, categories, markets, own-brand), or to save a `learnable` fact from a result. The update merges the given facts into the existing profile; it does not replace the whole profile." +
        HARD_RULES,
      inputSchema: {
        role: z
          .enum(["manufacturer", "importer", "distributor", "authorised_representative", "fulfilment_service_provider"])
          .optional()
          .describe("The company's role in the supply chain per EU DPP regulations."),
        ownBrand: z
          .boolean()
          .optional()
          .describe("True if the company sells under its own brand or trademark."),
        categories: z
          .array(z.string().max(100))
          .optional()
          .describe("Product categories the company handles, e.g. [\"battery\", \"textile\"]."),
        markets: z
          .array(z.string().max(10))
          .optional()
          .describe("ISO country codes where the company sells, or [\"EU\"]."),
        sizeBand: z
          .enum(["sme", "large"])
          .optional()
          .describe("Whether the company is an SME or a large enterprise."),
        salesChannels: z
          .array(z.enum(["own_shop", "marketplace", "retail", "b2b", "fulfilment"]))
          .optional()
          .describe("Sales channels the company uses."),
        dataSystems: z
          .string()
          .max(200)
          .optional()
          .describe("Short description of the data systems the company uses (e.g. SAP, custom ERP)."),
        products: z
          .array(
            z.object({
              name: z.string().max(255),
              category: z.string().max(100),
              facts: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .max(50)
          .optional()
          .describe("Up to 50 representative products, used as defaults for passport creation."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        const patch: Record<string, unknown> = {};
        if (args.role !== undefined) patch.role = args.role;
        if (args.ownBrand !== undefined) patch.ownBrand = args.ownBrand;
        if (args.categories !== undefined) patch.categories = args.categories;
        if (args.markets !== undefined) patch.markets = args.markets;
        if (args.sizeBand !== undefined) patch.sizeBand = args.sizeBand;
        if (args.salesChannels !== undefined) patch.salesChannels = args.salesChannels;
        if (args.dataSystems !== undefined) patch.dataSystems = args.dataSystems;
        if (args.products !== undefined) patch.products = args.products;
        return complianceResult(await client.patch("/api/v1/company/compliance-profile", patch));
      },
    },

    // -------------------------------------------------------------------------
    // 9. delete_profile
    //
    // Annotation: destructiveHint=true — removes every stored fact.
    // -------------------------------------------------------------------------
    {
      name: "delete_profile",
      title: "Delete all stored company facts",
      description:
        "Deletes every stored company fact. Use it only when the user explicitly asks to delete their profile. This is a separate tool so the assistant asks for confirmation before running it." +
        HARD_RULES,
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      handler: async () => complianceResult(await client.delete("/api/v1/company/compliance-profile")),
    },
  ];
}

/** Build the compliance `McpServer`. The caller connects it to a transport. */
export function createComplianceMcpServer(config: CreateComplianceMcpServerConfig): McpServer {
  const server = new McpServer(COMPLIANCE_SERVER_INFO, {
    instructions:
      "You are the TracePass DPP Compliance Assistant. You answer EU Digital Product Passport scope, field, registry and change questions. " +
      "Answer every question about what EU DPP law requires, or about the registry and its standards, from a tool result: call the closest tool first, even when you think you know the answer, and if the result does not cover the question, say so. " +
      "Questions about vendors, software, providers or prices are not in the tools: call no tool, and say you do not compare, rank or price vendors. " +
      "Use only what the tools return: add no facts, dates or articles of your own, not even today's date. Keep every citation and the disclaimer. " +
      "For a scope question, call scope_check. For field requirements, call required_fields. For law changes, call what_changed. For registry, call registry_guidance. " +
      "When the user asks to create a passport, call create_draft_passport — it never publishes. " +
      "Offer to save any lasting company facts the user states (role, categories, markets) with update_profile. " +
      "If an answer is flagged as wrong, call report_answer with the user's words and the ruleIds. " +
      "Say answers are \"Planned, not law yet\" for planned items. " +
      "Where ruleStatus is needs_recheck, say the law behind the act changed and the rules are being re-checked. " +
      "End every answer with the disclaimer line from the result.",
  });

  const client = new TracePassClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    source: COMPLIANCE_SOURCE,
  });

  for (const tool of buildComplianceTools(client)) {
    const cb = async (args: Record<string, unknown>) => {
      try {
        return await tool.handler(args ?? {});
      } catch (err) {
        return errorResult(`Tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb as any,
    );
  }

  return server;
}
