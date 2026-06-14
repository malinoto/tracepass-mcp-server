/**
 * MCP prompts for the TracePass server.
 *
 * Prompts are reusable, parameterised instructions the MCP client
 * surfaces to the user (typically as slash-commands). They are not
 * tool calls — a prompt returns a `messages` array that seeds the
 * conversation, after which the model uses the TracePass tools to
 * carry out the workflow.
 *
 * Each prompt here encodes a common DPP workflow so a user doesn't
 * have to phrase it from scratch — and so the model approaches the
 * task the way TracePass intends (e.g. always reviewing before
 * publishing, never bulk-creating billable passports without
 * consent).
 *
 * Pure — no IO. `registerPrompts(server)` wires them onto the server.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Build a GetPromptResult from a single user-role text message. */
function userPrompt(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text },
      },
    ],
  };
}

/**
 * Register every TracePass prompt on the server.
 */
export function registerPrompts(server: McpServer): void {
  // ── Audit a passport's completeness ───────────────────────────
  server.registerPrompt(
    "audit_passport",
    {
      title: "Audit a passport",
      description:
        "Review one Digital Product Passport for completeness and compliance readiness — which required fields are missing, which economic-operator parties are unset, whether it's publishable.",
      argsSchema: {
        passportId: z
          .string()
          .describe("The TracePass id of the passport to audit."),
      },
    },
    ({ passportId }) =>
      userPrompt(
        `Audit the TracePass Digital Product Passport with id "${passportId}".\n\n` +
          `1. Run tracepass_passports (action: compliance, args: { id: "${passportId}" }) for the authoritative verdict — missing/unapproved required fields, missing economic-operator parties, format issues, and per-category conditional rules, each with the regulation it cites.\n` +
          `2. For the status + completion percentage (and full field detail if you need it), also fetch tracepass_passports (action: get, format: full).\n` +
          `3. Report the verdict (compliant | compliant_with_warnings | incomplete), the prioritised critical gaps, then the warnings.\n` +
          `4. State plainly whether the passport is ready to publish, and if not, the exact gaps to close.\n` +
          `Do not change anything — this is a read-only audit.`,
      ),
  );

  // ── Set up a product + its first passport ─────────────────────
  server.registerPrompt(
    "onboard_product",
    {
      title: "Onboard a new product",
      description:
        "Walk through creating a new product and its first Digital Product Passport — gathering the details, then creating both.",
      argsSchema: {
        productName: z.string().describe("The product's name."),
        category: z
          .string()
          .describe(
            "Category key — battery, textile, electronics, construction, steel, chemicals, packaging, furniture, tyres, jewelry, toys, or fmcg.",
          ),
      },
    },
    ({ productName, category }) =>
      userPrompt(
        `Help me onboard a new product into TracePass: "${productName}" in the "${category}" category.\n\n` +
          `1. Confirm the product details with me (model / SKU, description), then create it with tracepass_products (action: create).\n` +
          `2. Ask me for the first unit's GTIN and serial number.\n` +
          `3. Before creating the passport, remind me that a passport is BILLABLE and consumes a plan DPP slot. ` +
          `Only after I confirm, create it with tracepass_passports (action: create).\n` +
          `4. If the account is over its plan quota, tell me the overage cost and wait for my explicit go-ahead before retrying with confirmOverage.`,
      ),
  );

  // ── Explain a category's compliance requirements ──────────────
  server.registerPrompt(
    "explain_dpp_requirements",
    {
      title: "What does a compliant DPP require?",
      description:
        "Explain what a Digital Product Passport in a given category must contain to be compliant — the required fields and the EU regulation behind them — before you create anything.",
      argsSchema: {
        category: z
          .string()
          .describe(
            "Category key — battery, textile, electronics, construction, steel, chemicals, packaging, furniture, tyres, jewelry, toys, or fmcg.",
          ),
      },
    },
    ({ category }) =>
      userPrompt(
        `Explain what a compliant "${category}" Digital Product Passport requires under EU regulation.\n\n` +
          `1. Fetch the schema with tracepass_templates (action: get, args: { category: "${category}" }).\n` +
          `2. State the governing regulation (name + number + mandatory date) and how many of the fields are REQUIRED vs optional.\n` +
          `3. Group the required fields by their access level (public / restricted / authority) and, where a field cites a regulation article/annex, name it — so I understand WHY each field is needed, not just that it is.\n` +
          `4. Call out anything that is commonly hard to source (e.g. supplier-held data, test reports) so I can plan ahead.\n` +
          `This is advisory and read-only — do not create a product or passport.`,
      ),
  );

  // ── Compliance gap-check a passport before publishing ─────────
  server.registerPrompt(
    "compliance_gap_check",
    {
      title: "Compliance gap-check before publish",
      description:
        "Cross-check a draft passport against its category's regulatory schema and produce an exact, prioritised list of what's missing before it can be published compliantly.",
      argsSchema: {
        passportId: z
          .string()
          .describe("The TracePass id of the passport to gap-check."),
      },
    },
    ({ passportId }) =>
      userPrompt(
        `Do a compliance gap-check on the TracePass passport "${passportId}".\n\n` +
          `1. Run tracepass_passports (action: compliance, args: { id: "${passportId}" }). This returns the authoritative verdict — \`verdict\` (compliant | compliant_with_warnings | incomplete), \`critical\` and \`warnings\` findings (each with the regulation + article it cites), and \`conditionalCoverage\` (whether per-category conditional rules ran, or the category is "static-only" with no binding conditionals yet).\n` +
          `2. Present the findings as a prioritised list: every \`critical\` finding first (these block compliant publishing — show its target field/party, why, the cited regulation/article, and the fix), then the \`warnings\` (format issues, recommended-not-mandatory gaps, and any "unverifiable_conditional" where data was missing to evaluate a rule).\n` +
          `3. If you want optional-but-recommended fields beyond what the verdict flags, fetch the category schema with tracepass_templates (action: get) and note high-value optional fields — clearly separated from the mandatory gaps above.\n` +
          `4. End with the one-line verdict and the single most important thing to fix first. If \`conditionalCoverage\` is "static-only", say so — it means no binding conditional rules exist for this category yet, not that the passport is fully future-proof.\n` +
          `Read-only — do not change field values or publish. The reviewer decides.`,
      ),
  );

  // ── Reconcile EPCIS supply-chain events ───────────────────────
  server.registerPrompt(
    "review_epcis_events",
    {
      title: "Review a passport's EPCIS events",
      description:
        "Inspect the EPCIS 2.0 supply-chain event history of a passport and summarise the product's traceability story.",
      argsSchema: {
        passportId: z
          .string()
          .describe("The TracePass id of the passport whose events to review."),
      },
    },
    ({ passportId }) =>
      userPrompt(
        `Review the EPCIS 2.0 supply-chain events for the TracePass passport "${passportId}".\n\n` +
          `1. Export them with tracepass_epcis (action: export).\n` +
          `2. Summarise the product's traceability story in plain language — the sequence of events ` +
          `(commissioning, production steps, shipping, service, ownership changes), with dates and locations.\n` +
          `3. Flag any gaps — e.g. a long unexplained period, a missing production step, events with no location.\n` +
          `This is read-only; do not capture or modify any events.`,
      ),
  );
}
