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
          `1. Fetch it with the tracepass_passports tool (action: get, format: full).\n` +
          `2. Report: which required template fields are still empty or unapproved; ` +
          `which economic-operator parties (manufacturer / importer / recycler / etc.) are missing; ` +
          `the passport's status and completion percentage.\n` +
          `3. State plainly whether the passport is ready to publish, and if not, the exact gaps to close.\n` +
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
