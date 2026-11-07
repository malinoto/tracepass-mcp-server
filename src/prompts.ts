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
 * publishing, never bulk-creating passports without consent).
 *
 * Pure — no IO. `registerPrompts(server)` wires them onto the server.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Build a GetPromptResult from a single user-role text message.
 * @param text the message text
 * @returns a prompt result with one user message
 */
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
 * @param server the server to register the prompts on
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
        passportId: z.string().describe("The TracePass id of the passport to audit."),
      },
    },
    ({ passportId }) =>
      userPrompt(
        `Audit the TracePass Digital Product Passport with id "${passportId}".\n\n` +
          `1. Run tracepass_passports (action: compliance, args: { id: "${passportId}" }) for the authoritative verdict — missing/unapproved required fields, missing economic-operator parties, format issues, and per-category conditional rules, each with the regulation it cites.\n` +
          `2. For the status + completion percentage (and full field detail if you need it), also fetch tracepass_passports (action: get, format: full).\n` +
          `3. Report the verdict (compliant | compliant_with_warnings | incomplete), the prioritised critical gaps, then the warnings.\n` +
          `4. Note where a filled value's backing is weak. A field may carry \`sourceProvider\` naming the source that vouches for it (for example a public register), with \`sourceUrl\` linking the record. A value a named register vouches for is the strongest and cheapest to confirm. \`sourceProvider: "research"\` means the value was sourced from the web and deserves a closer look. No \`sourceProvider\` means no single source vouches for the stored value: it was entered by a person or read from an uploaded document. That is not a defect; verify the low-confidence values without a source first.\n` +
          `5. State plainly whether the passport is ready to publish, and if not, the exact gaps to close.\n` +
          `6. For a battery passport, also run tracepass_passports (action: registry_readiness) and report \`placeOnMarketStatus\` from the get: placing, placed (with the registration ID) or rejected (with the reason). Registration in the EU DPP Registry is a separate step after publishing, and the economic operator does it itself on the Registry website: TracePass prepares the address to paste (tracepass_passports, action: prepare_registry_upi) and records the registration once the operator reports it (tracepass_passport_lifecycle, action: record_registration). When the passport is published and not placed, name that as the next step (the register_battery_passport prompt walks it through), but never run either write without the user's explicit confirmation.\n` +
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
            "Category key — battery, textile, electronics, construction, steel, detergents, paints-coatings, packaging, furniture, tyres, jewelry, toys, or fmcg.",
          ),
      },
    },
    ({ productName, category }) =>
      userPrompt(
        `Help me onboard a new product into TracePass: "${productName}" in the "${category}" category.\n\n` +
          `1. Confirm the product details with me (model / SKU, description), then create it with tracepass_products (action: create).\n` +
          `2. Ask me for the first unit's identifier. Explain the five EN 18219 schemes and let me choose:\n` +
          `   • gs1 — GS1 GTIN + serial number (e.g. GTIN "04012345000015", serial "SN-001").\n` +
          `   • iso15459 — ISO/IEC 15459: issuing agency code, primary ID, optional serial, and the raw concatenated string.\n` +
          `   • iec61406 — an IEC 61406 Identification Link (https URI).\n` +
          `   • did — a W3C Decentralised Identifier (DID string + method).\n` +
          `   • doi — an ISO 26324 Digital Object Identifier (bare "10.<registrant>/<suffix>" form) plus a required granularity: "model", "batch", or "item" (EN 18219 §5.6.2(b)).\n` +
          `   Note: battery passports accept ONLY gs1 or iso15459 (Battery Regulation Art. 77(3)).\n` +
          `3. Create the passport with tracepass_passports (action: create, args: { productId, identifier: {...} }). ` +
          `Tell me it is a draft: it takes no plan DPP slot and is not billed until someone publishes it in TracePass.`,
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
            "Category key — battery, textile, electronics, construction, steel, detergents, paints-coatings, packaging, furniture, tyres, jewelry, toys, or fmcg.",
          ),
      },
    },
    ({ category }) =>
      userPrompt(
        `Explain what a compliant "${category}" Digital Product Passport requires under EU regulation.\n\n` +
          `1. Fetch the schema with tracepass_templates (action: get, args: { category: "${category}" }).\n` +
          `2. State the governing regulation (name + number + mandatory date) and how many of the fields are REQUIRED vs optional. If the response carries requiredFieldCountByCategory, required-ness VARIES by product category — give the per-category figures, not the flat requiredFieldCount, and say which category each applies to. For battery specifically: only EV, LMT and industrial >2 kWh owe a passport at all (Art. 77(1)); if I named a portable or SLI battery, say it is out of scope rather than listing required fields.\n` +
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
        passportId: z.string().describe("The TracePass id of the passport to gap-check."),
      },
    },
    ({ passportId }) =>
      userPrompt(
        `Do a compliance gap-check on the TracePass passport "${passportId}".\n\n` +
          `1. Run tracepass_passports (action: compliance, args: { id: "${passportId}" }). This returns the authoritative verdict — \`verdict\` (compliant | compliant_with_warnings | incomplete), \`critical\` and \`warnings\` findings (each with the regulation + article it cites), and \`conditionalCoverage\` (whether per-category conditional rules ran, or the category is "static-only" with no binding conditionals yet).\n` +
          `2. Present the findings as a prioritised list: every \`critical\` finding first (these block compliant publishing — show its target field/party, why, the cited regulation/article, and the fix), then the \`warnings\` (format issues, recommended-not-mandatory gaps, use data a battery in service is expected to carry, and any "unverifiable_conditional" where data was missing to evaluate a rule).\n` +
          `3. If you want optional-but-recommended fields beyond what the verdict flags, fetch the category schema with tracepass_templates (action: get) and note high-value optional fields — clearly separated from the mandatory gaps above.\n` +
          `4. If a finding targets a field that IS filled (a format issue, or a value the reviewer should re-check), fetch tracepass_passports (action: get, format: full) and say where that value came from: \`sourceProvider\` names the source that vouches for it, with \`sourceUrl\` linking the record. A value a named register vouches for is cheap to confirm; one with \`sourceProvider: "research"\` or none at all is where a reviewer's time is best spent. An absent \`sourceProvider\` is not itself a gap.\n` +
          `5. End with the one-line verdict and the single most important thing to fix first. If \`conditionalCoverage\` is "static-only", say so — it means no binding conditional rules exist for this category yet, not that the passport is fully future-proof. For a published battery passport, say whether it is placed on the market (\`placeOnMarketStatus\`); if not, the next step is the operator's own registration on the EU DPP Registry website, which TracePass prepares (tracepass_passports, action: prepare_registry_upi) and then records (tracepass_passport_lifecycle, action: record_registration), each only on the user's confirmation.\n` +
          `Read-only — do not change field values or publish. The reviewer decides.`,
      ),
  );

  // ── Register a battery passport in the EU DPP Registry ────────
  server.registerPrompt(
    "register_battery_passport",
    {
      title: "Register a battery passport in the EU DPP Registry",
      description:
        "Walk the economic operator through registering a published battery passport in the EU DPP Registry: check readiness, prepare the address (or an upload file) the operator submits on the Registry website, then record the result the operator reports. TracePass never submits and never verifies.",
      argsSchema: {
        passportId: z
          .string()
          .describe("The TracePass id of the published battery passport to register."),
      },
    },
    ({ passportId }) =>
      userPrompt(
        `Help me register the TracePass battery passport "${passportId}" in the EU DPP Registry.\n\n` +
          `How it works: I, the economic operator, register the passport myself on the EU DPP Registry website under my own EU Login. TracePass prepares what I submit and records what I report back; it never submits to the Registry and never verifies the result. The Registry has two environments: acceptance (for testing, no legal effect) and production (the registration that counts).\n\n` +
          `1. Read the passport with tracepass_passports (action: get). It must be a published battery passport. If \`placeOnMarketStatus\` is already "placed", tell me and stop.\n` +
          `2. Run tracepass_passports (action: registry_readiness, args: { id: "${passportId}" }). If \`ready\` is false, list the blocking findings with their fixes and stop until they are fixed.\n` +
          `3. Ask me before preparing, then run tracepass_passports (action: prepare_registry_upi, args: { id: "${passportId}" }). Give me the \`upi\` exactly as returned, to paste into the Registry's online form. If it is refused with registry_not_ready, show \`findingDetails\` (blockers first). For several passports at once, use action: prepare_registry_upload_file with { passportIds } instead: give me \`xml\` to save unchanged under \`filename\` and upload on the Registry website, and list every \`excluded\` passport with its reason.\n` +
          `4. Suggest I try it in the acceptance environment first. When I report the outcome, ask before recording it with tracepass_passports (action: record_acceptance_test, args: { id, result: "passed" | "failed", errorCode? }). Remind me this has no legal effect.\n` +
          `5. Once I tell you I have registered it in the production Registry, confirm with me before recording it with tracepass_passport_lifecycle (action: record_registration, args: { id, placedOnMarketAt? (YYYY-MM-DD, defaults to today), registrationId? }). Say first that this marks the passport placed on the market and locks its operator and facility identifiers, and that TracePass records my statement without checking it with the Registry.\n` +
          `6. If I recorded something by mistake, tracepass_passport_lifecycle (action: undo_registration, args: { id, environment }) removes the record, after my confirmation. It changes nothing in the Registry.\n` +
          `Never record a registration I have not told you I made. Do not use place_on_market for this: the EU DPP Registry does not accept it.`,
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
        passportId: z.string().describe("The TracePass id of the passport whose events to review."),
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
