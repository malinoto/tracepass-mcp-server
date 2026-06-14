# TracePass MCP Server

[![Listed on Glama](https://glama.ai/mcp/servers/malinoto/tracepass-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/malinoto/tracepass-mcp-server)

A [Model Context Protocol](https://modelcontextprotocol.io) server for
**[TracePass](https://www.tracepass.eu)** — the EU Digital Product
Passport platform. It lets AI assistants (Claude, Cursor, IDE agents)
manage products, Digital Product Passports, economic-operator parties,
and GS1 EPCIS 2.0 supply-chain events.

It speaks the full MCP protocol — **tools**, **resources**, **resource
templates**, and **prompts**.

## Two ways to use it

The same server core ships two ways:

1. **Hosted** — point your MCP client at `https://ai.tracepass.eu/mcp`.
   Nothing to install; always current.
2. **Local (npm)** — run `tracepass-mcp-server` via `npx`. The MCP
   client launches it as a subprocess and speaks MCP over stdio.

**Authentication — two options:**
- **API key** (simplest, works for both hosted + local) — mint a `tp_…`
  key in the dashboard under **Developer → API Keys** and send it as a
  Bearer token. Best for a single user / server-to-server.
- **OAuth 2.0** (hosted endpoint only) — MCP clients that support OAuth
  (e.g. Claude.ai, ChatGPT) can "Connect" to `https://ai.tracepass.eu/mcp`
  without pasting a key: the user authorizes the server on a TracePass
  consent screen and grants specific scopes. Discovery is automatic via
  the server's RFC 9728 metadata
  (`/.well-known/oauth-protected-resource`) → the platform's
  authorization server. Register an app under **Developer → OAuth Apps**
  if you're distributing your own client.

## Configuration

### Hosted

```json
{
  "mcpServers": {
    "tracepass": {
      "url": "https://ai.tracepass.eu/mcp",
      "headers": { "Authorization": "Bearer tp_YOUR_KEY" }
    }
  }
}
```

### Local (npx / stdio)

```json
{
  "mcpServers": {
    "tracepass": {
      "command": "npx",
      "args": ["-y", "tracepass-mcp-server"],
      "env": {
        "TRACEPASS_API_KEY": "tp_YOUR_KEY"
      }
    }
  }
}
```

Optional env var: `TRACEPASS_BASE_URL` (defaults to
`https://app.tracepass.eu`) — point the tools at a different
TracePass deployment.

## Tools

The TracePass v1 API operations are grouped into **6 tools**,
each taking an `action` plus action-specific `args`:

| Tool | Actions |
|------|---------|
| `tracepass_products` | `list`, `get`, `create`, `update` |
| `tracepass_passports` | `list`, `get`, `get_by_serial`, `compliance`, `create`, `suspend`, `suspend_by_serial`, `archive`, `archive_by_serial`, `get_qr` |
| `tracepass_passport_fields` | `update`, `update_by_serial` |
| `tracepass_passport_parties` | `set`, `remove` |
| `tracepass_epcis` | `export`, `export_by_serial`, `capture`, `capture_job`, `query` |
| `tracepass_templates` | `list`, `get` |

The **`*_by_serial`** actions address a passport by the customer's own serial
number instead of its TracePass id. A serial is unique only *within a GTIN*, so
if the same serial exists under two GTINs in your account a serial-only call
returns **409 `ambiguous_serial`** — pass the optional `gtin` arg to disambiguate
(or use the by-id action). The same `gtin` disambiguator applies to every
`*_by_serial` action.

The **`tracepass_passports` `compliance`** action returns a three-tier
compliance verdict (`compliant` / `compliant_with_warnings` /
`incomplete`) with regulation-cited findings — missing required fields,
missing economic-operator parties, format issues, and per-category
conditional rules. Read-only; use it to gap-check a passport, fix the
cited gaps, then re-check.

### A note on writes

Some actions **cost money or are irreversible** — the server's tool
descriptions tell the model so:

- **`tracepass_passports` `create`** consumes a billable DPP slot on
  the account's plan. Over-quota creation incurs a per-passport
  overage charge; the tool surfaces a 402-style message and only
  proceeds with `args.confirmOverage: true` after the user agrees.
- **`tracepass_passports` `archive`** is irreversible — the public QR
  permanently 404s. Use `suspend` (reversible) when a change might be
  undone.
- **`tracepass_epcis` `capture` / `query`** require the paid EPCIS
  add-on; `export` is included on Starter plans and up.

## Resources

Read-only entity data you can attach as conversation context:

- `tracepass://products` — the product catalogue
- `tracepass://product/{id}` — one product
- `tracepass://passport/{id}` — one passport, full field detail
- `tracepass://passport/{id}/epcis` — a passport's EPCIS 2.0 events
- `tracepass://passport/{id}/compliance` — a passport's compliance verdict
- `tracepass://templates` — all 12 DPP category regulatory schemas
- `tracepass://template/{category}` — one category's full field schema

## Prompts

Reusable DPP workflows the client surfaces as slash-commands:

- `audit_passport` — review a passport for completeness and
  compliance readiness
- `onboard_product` — create a product and its first passport
- `explain_dpp_requirements` — explain what a category's compliant DPP
  must contain, and the regulation behind each field
- `compliance_gap_check` — produce a prioritised, regulation-cited list
  of what's blocking a passport's compliant publication
- `review_epcis_events` — summarise a passport's supply-chain trail

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm run typecheck
npm test             # vitest
npm run lint
npm start            # run the hosted HTTP service locally (:8080)
npm run start:stdio  # run the stdio server locally
```

The hosted service is a plain Node HTTP server (`dist/http.js`),
stateless — each request carries its own API key and builds a fresh
MCP session. It is containerised via the `Dockerfile` and deployed to
Hetzner; see `tracepass-environment/docker-mcp.yml`.

## Listed on Glama

This server is published in the [official MCP Registry](https://registry.modelcontextprotocol.io)
as `eu.tracepass/tracepass` and listed on [Glama](https://glama.ai/mcp/servers/malinoto/tracepass-mcp-server):

[![TracePass MCP server](https://glama.ai/mcp/servers/malinoto/tracepass-mcp-server/badges/card.svg)](https://glama.ai/mcp/servers/malinoto/tracepass-mcp-server)

## License

MIT
