# tracepass-mcp-server

MCP server for TracePass — lets AI assistants manage products, Digital Product
Passports, economic-operator parties, and GS1 EPCIS 2.0 events over the TracePass
v1 REST API. Speaks the full MCP protocol: tools, resources, resource templates,
prompts. Read `README.md` for usage; this file is the agent guardrail layer.

> **This is a PUBLIC npm package** (`tracepass-mcp-server`, integrators `npx` it).
> Nothing internal — no prod paths, SSH aliases, secrets, hosting details, or
> operational fingerprint — belongs in this repo. Deploy/ops artefacts and
> release keys live in private repos kept outside this one. Keep it that way when
> editing this file.

## Architecture (the one rule everything serves)

**One server core, every transport — the tool surface must never drift between
the hosted endpoint and the local package.**

- `src/server.ts` — `createMcpServer(config)`: builds the `McpServer` with all
  tools/resources/prompts. **Transport-agnostic** — knows nothing about stdio vs HTTP.
- `src/http.ts` — hosted entrypoint (the Node service behind `https://ai.tracepass.eu/mcp`).
  Stateless: fresh server+transport per request, credential from `Authorization: Bearer …`.
- `src/stdio.ts` — local/`npx` entrypoint. Client launches it as a subprocess; key
  from `TRACEPASS_API_KEY` env.
- Both call the **same** `createMcpServer`. Only the transport + key source differ.
  Any change to the tool surface must go through the core so both forms stay identical.

**Auth: the hosted server supports BOTH a `tp_` API key AND OAuth 2.0 — and it's
a pass-through, not a branch.** `src/http.ts` forwards the client's
`Authorization: Bearer <token>` to the v1 API unchanged; the **platform's unified
auth gate** decides whether it's a `tp_…` service-account key or an OAuth access
token. The MCP server never inspects the token type. OAuth-capable clients
(Claude.ai etc.) discover the authorization server via the RFC 9728
`/.well-known/oauth-protected-resource` challenge; the local `stdio` form is
API-key-only (`TRACEPASS_API_KEY`) because a subprocess has no browser for the
OAuth consent step. **Consequence:** `401` responses from the hosted endpoint are
*normal* — they're the RFC 9728 start-auth signal an OAuth client gets before it
has a token, plus token-expiry retries. A 401 here is not a fault; the path is
verified working with both `api_key` and `oauth` 200s in prod
(`apiRequestLog`, 2026-06-18). Don't "fix" the 401s by removing the challenge.

**Auth is METHOD-AWARE, not blanket (since v1.4.4).** The MCP handshake +
discovery — `initialize`, `tools/list`, `prompts/list`, `resources/list`,
`ping`, etc. (`PUBLIC_METHODS` in `src/http.ts`) — are served WITHOUT a
credential; only methods whose handlers hit the v1 API (`tools/call`,
`resources/read`, `prompts/get`) require a Bearer token. **Why:** MCP catalogs
+ scanners (mcppedia, Glama) probe unauthenticated — when `tools/list` was
gated behind auth, they got 401 and listed the server as **"0 tools"** (mcppedia
scored it Grade F) despite 6 tools existing. Discovery must precede auth. The
gate is fail-closed (unparseable / unknown / batched-mixed body → require auth),
and `tools/call` still returns a real 401 + `WWW-Authenticate`. Don't re-gate
`tools/list`/`initialize` — you'll re-break catalog discovery. Verified live
2026-06-19: anon `tools/list` → 6 tools, `tools/call` → 401.

**Tools call the v1 API over HTTP, not `lib/` in-process** (`src/api-client.ts`).
Deliberate: the v1 route handlers already own API-key auth, idempotency, the 402
overage flow, plan-gating, and rate-limit counters — re-implementing that in the
tools would drift. One bug surface, not two. The loopback hop when hosted is
negligible. Don't "optimize" this into direct lib calls.

## Tool/result conventions to preserve

- **5 resource tools, not ~23 flat ones** (`src/tools.ts`). Each takes `action`
  (enum) + `args` (shape depends on `action`). MCP `inputSchema` can't branch on
  `action`, so `args` is declared permissively and each handler validates against
  the specific per-action Zod schema (`ACTION_SCHEMAS`). When adding an endpoint,
  add an action to the right resource tool — don't add a 6th flat tool unless it's
  genuinely a new resource.
- **402 / 403 / 429 are meaningful results, not exceptions** (`src/result.ts`).
  402 overage → agent can retry with `confirmOverage: true`; 403 plan-gate → tell
  the user, don't retry; 429 → daily budget spent, retry tomorrow. Surface these as
  readable `isError: true` text so the model can explain them. Don't let them throw.
- **Billable / irreversible actions are spelled out in the tool description** so
  the model warns the user first. Keep that discipline when adding actions —
  especially anything that creates passports (billable) or publishes.
- Resources = read-only context (`tracepass://…` URIs); prompts = workflow seeds
  that encode TracePass's intended approach (review before publish, no bulk-billable
  creation without consent). Keep both pure / IO-free where they already are.

## Releasing (THREE independent channels)

A release ships over **three separate channels off the same `src/`** — doing one
does NOT do the others, and **publishing to npm does NOT update the hosted
endpoint**:

1. **npm** — `v*.*.*` git tag push → `.github/workflows/publish.yml` (OIDC), never
   laptop `npm publish`. Bump `package.json` AND `server.json` — note `server.json`
   carries the version in **two** spots (top-level `version` + `packages[0].version`);
   keep `"mcpName": "eu.tracepass/tracepass"`.
2. **MCP Registry** (`eu.tracepass/tracepass`) — separate `mcp-publisher` step,
   DNS-namespace auth.
3. **Hosted endpoint** (`ai.tracepass.eu/mcp`) — a separate redeploy of this source.

The exact release/deploy procedure (auth, keys, deploy mechanics) is internal —
it is **not** documented in this public repo. Run the `publish-npm-package` skill,
which holds the full steps.

## Before changing anything

- `npm run lint && npm run typecheck && npm test` (vitest) green.
- The v1 API contract is owned by `tracepass-platform` — if a tool needs a field
  the API doesn't return, the change starts there, not here.
- Listed on Glama + Smithery (`glama.json`, `smithery-config-schema.json`); keep
  those in sync if tool/config surface changes.

---
*The v1 API contract is owned by the TracePass platform; release procedures and
cross-repo conventions live in the private workspace tooling, not in this public
repo.*
