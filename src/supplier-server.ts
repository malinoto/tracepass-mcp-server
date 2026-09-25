/**
 * The SUPPLIER MCP server — how a supplier's own AI assistant answers one
 * TracePass data request.
 *
 * A TracePass customer asks a supplier for product data (a component's CAS
 * numbers, a certificate, a recycled-content figure). The supplier gets an
 * email with a link. Instead of filling the web form, they can connect their
 * assistant to `https://ai.tracepass.eu/supplier/mcp/<token>`, and the
 * assistant reads what is asked, finds the answers in the supplier's own
 * documents, and submits them with evidence.
 *
 * A separate server from `createMcpServer`, on purpose:
 *   - Different principal. The credential is the request's own token, which
 *     authorises ONE request, not a TracePass account. There is no OAuth: a
 *     supplier has no account to log in to.
 *   - Different surface. Five small tools, none of the customer tools, and it
 *     is not part of the `eu.tracepass/tracepass` registry listing.
 *
 * It follows the same rule as the main server: tools call the platform over
 * HTTP (`/api/supplier/v1/*`), which owns filtering, merging, review and rate
 * limits. Nothing here decides what a supplier may write.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TracePassClient } from "./api-client.js";
import { MCP_SERVER_INFO } from "./server.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

export const SUPPLIER_SERVER_INFO = {
  name: "tracepass-supplier",
  version: MCP_SERVER_INFO.version,
} as const;

export interface CreateSupplierMcpServerConfig {
  baseUrl: string;
  /** The supplier request token, from the connection URL or the Bearer header.
   *  Empty when the client connected without one: discovery still works, and
   *  every tool explains how to connect. */
  token: string;
}

/**
 * The supplier MCP endpoint (see supplier-server.ts). Two forms:
 *   /supplier/mcp/<token>  — the token in the path, for clients that only take
 *                            a URL (Claude.ai and ChatGPT custom connectors);
 *   /supplier/mcp          — the token as `Authorization: Bearer <token>`.
 * The token already travels in the emailed web-form link, so the path form
 * exposes nothing new.
 */
const SUPPLIER_MCP_PATH = "/supplier/mcp";

/** A supplier token in a path segment: the platform mints 64 hex chars; accept
 *  a URL-safe superset and let the platform decide validity. */
const SUPPLIER_TOKEN_SEGMENT = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Match a supplier MCP path. Returns the token from the path ("" when it must
 * come from the header), or null when the path is not a supplier path.
 */
export function matchSupplierPath(pathname: string): { pathToken: string } | null {
  if (pathname === SUPPLIER_MCP_PATH || pathname === `${SUPPLIER_MCP_PATH}/`) return { pathToken: "" };
  if (!pathname.startsWith(`${SUPPLIER_MCP_PATH}/`)) return null;
  const segment = pathname.slice(SUPPLIER_MCP_PATH.length + 1).replace(/\/$/, "");
  return SUPPLIER_TOKEN_SEGMENT.test(segment) ? { pathToken: segment } : null;
}

const NO_TOKEN =
  "This connection has no supplier request token. Connect with the personal link from the TracePass request email: https://ai.tracepass.eu/supplier/mcp/<token> (or send the token as Authorization: Bearer <token>).";

/**
 * Supplier-facing wording for the platform's answers. The customer server's
 * `apiResult` talks about API keys and plans; a supplier has neither.
 */
export function supplierResult(res: { status: number; ok: boolean; body: unknown }): ToolResult {
  if (res.ok) return jsonResult(res.body);
  const body = (res.body ?? {}) as Record<string, unknown>;
  const detail = typeof body.error === "string" ? body.error : undefined;
  switch (res.status) {
    case 400:
      return errorResult(`The request was malformed: ${detail ?? "check the tool arguments."}`);
    case 401:
    case 404:
      return errorResult(
        "This request link is not valid. It may have been replaced by a newer email from the requester. Ask the user for the latest link.",
      );
    case 409:
      return errorResult(
        `${detail ?? "The requester has already reviewed this request."} Answers can no longer be changed. Call get_request to see the outcome.`,
      );
    case 410:
      return errorResult(
        "This request has expired or was cancelled by the requester. The user should contact the requester for a new link.",
      );
    case 413:
      return errorResult(`The file is too large: ${detail ?? "the limit is 10 MB."}`);
    case 429:
      return errorResult("Too many calls for this request in the last minute. Wait a minute, then retry.");
    default:
      return errorResult(`TracePass returned ${res.status}. ${detail ?? JSON.stringify(res.body)}`);
  }
}

const evidenceSchema = z
  .object({
    documentId: z.string().optional().describe("An id returned by upload_evidence for this request."),
    url: z.string().optional().describe("A public http(s) page that states the value, e.g. a datasheet or a register entry."),
    note: z.string().optional().describe("Where in the source the value is, e.g. 'datasheet p.3, table 2'."),
  })
  .describe("Where one value comes from.");

interface SupplierTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export function buildSupplierTools(client: TracePassClient, hasToken: boolean): SupplierTool[] {
  const guard =
    (fn: (args: Record<string, unknown>) => Promise<ToolResult>) =>
    async (args: Record<string, unknown>): Promise<ToolResult> =>
      hasToken ? fn(args) : errorResult(NO_TOKEN);

  return [
    {
      name: "get_request",
      title: "Read the data request",
      description:
        "Start here. Returns who is asking, for which product, and every field requested: its meaning, data type, unit, allowed options, expected format and the EU law it comes from (with the quoted provision). Also returns the answers already submitted and, once reviewed, the outcome. Read-only.",
      inputSchema: {
        lang: z
          .string()
          .max(5)
          .optional()
          .describe("Language for labels and descriptions, e.g. 'de'. Defaults to English."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: guard(async (args) => {
        const lang = typeof args.lang === "string" && /^[a-z]{2}$/i.test(args.lang) ? args.lang : "";
        return supplierResult(await client.get(`/api/supplier/v1/request${lang ? `?lang=${lang}` : ""}`));
      }),
    },
    {
      name: "validate_answers",
      title: "Check answers without submitting",
      description:
        "Dry run. Reports which values would be stored, which keys were not requested (they are ignored), and which values do not fit the field's definition (wrong type, not an allowed option, out of range). Writes nothing. Use it before submit_answers.",
      inputSchema: {
        fieldValues: z
          .record(z.string(), z.unknown())
          .describe("Field key → value, using the keys from get_request."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: guard(async (args) =>
        supplierResult(await client.post("/api/supplier/v1/validate", { fieldValues: args.fieldValues ?? {} })),
      ),
    },
    {
      name: "upload_evidence",
      title: "Attach a supporting document",
      description:
        "Upload one file (a datasheet, certificate, test report, SDS) as evidence. Returns a documentId to cite in submit_answers. PDF, Office files, CSV and images; at most 10 MB. The requester can open it.",
      inputSchema: {
        filename: z.string().min(1).max(255),
        mimeType: z.string().describe("e.g. application/pdf, image/png"),
        contentBase64: z.string().min(1).describe("The file's bytes, base64-encoded."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler: guard(async (args) =>
        supplierResult(
          await client.post("/api/supplier/v1/documents", {
            filename: args.filename,
            mimeType: args.mimeType,
            contentBase64: args.contentBase64,
          }),
        ),
      ),
    },
    {
      name: "submit_answers",
      title: "Submit answers for review",
      description:
        "Send answers to the requester. They go to a human review, not straight into the product passport. Only requested fields are stored. You may call it again until the requester reviews it: each call merges with the earlier answers (a field sent again replaces its value; fields left out keep theirs). An answer cannot be withdrawn, only changed. Submit only values found in the supplier's own records or documents, never estimates or guesses; leave a field out when you do not know it. Confirm with the user before submitting, because the answers are sent to another company.",
      inputSchema: {
        fieldValues: z.record(z.string(), z.unknown()).describe("Field key → value."),
        evidence: z
          .record(z.string(), evidenceSchema)
          .optional()
          .describe("Field key → where the value comes from. Strongly recommended for every value."),
        notes: z.string().max(2000).optional().describe("A message to the requester."),
        documentIds: z
          .array(z.string())
          .optional()
          .describe("Uploaded documents to attach to the answer as a whole."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      handler: guard(async (args) =>
        supplierResult(
          await client.post("/api/supplier/v1/submit", {
            fieldValues: args.fieldValues ?? {},
            ...(args.evidence ? { evidence: args.evidence } : {}),
            ...(args.notes ? { notes: args.notes } : {}),
            ...(args.documentIds ? { documentIds: args.documentIds } : {}),
          }),
        ),
      ),
    },
    {
      name: "get_review_status",
      title: "Check the review outcome",
      description:
        "Whether the requester has reviewed the answers yet, the outcome, which fields they accepted and their note. Review has no deadline; linkExpiresAt is when this connection stops working. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: guard(async () => {
        const res = await client.get("/api/supplier/v1/request");
        if (!res.ok) return supplierResult(res);
        const body = (res.body ?? {}) as {
          request?: { status?: string; canSubmit?: boolean; linkExpiresAt?: string };
          submission?: { revision?: number; updatedAt?: string } | null;
          review?: unknown;
        };
        return jsonResult({
          status: body.request?.status ?? null,
          canStillChangeAnswers: body.request?.canSubmit ?? false,
          linkExpiresAt: body.request?.linkExpiresAt ?? null,
          submittedRevision: body.submission?.revision ?? null,
          lastSubmittedAt: body.submission?.updatedAt ?? null,
          review: body.review ?? null,
        });
      }),
    },
  ];
}

/** Build the supplier `McpServer`. The caller connects it to a transport. */
export function createSupplierMcpServer(config: CreateSupplierMcpServerConfig): McpServer {
  const server = new McpServer(SUPPLIER_SERVER_INFO, {
    instructions:
      "You are helping a supplier answer one product-data request from a TracePass customer, usually for an EU Digital Product Passport. " +
      "Call get_request first to see what is asked and why (each field carries its definition, unit and legal source). " +
      "Find each value in the supplier's own documents or records; never estimate or invent a value, and leave out any field you cannot source. " +
      "Use validate_answers to check, upload_evidence for supporting files, and cite a document, URL or note as evidence for each value. " +
      "Show the user the answers and get their confirmation before submit_answers: they are sent to another company for review. " +
      "Answers can be corrected until the requester reviews them; get_review_status shows the outcome.",
  });
  const hasToken = config.token.trim() !== "";
  const client = new TracePassClient({ baseUrl: config.baseUrl, apiKey: config.token });
  for (const tool of buildSupplierTools(client, hasToken)) {
    const cb = async (args: Record<string, unknown>) => {
      try {
        return await tool.handler(args ?? {});
      } catch (err) {
        return errorResult(`Tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb as any,
    );
  }
  return server;
}
