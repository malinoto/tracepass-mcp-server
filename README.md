# TracePass MCP Server

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

Both need a TracePass API key — mint one in the dashboard under
**Developer → API Keys** (a `tp_…` key).

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

The ~23 TracePass v1 API operations are grouped into **5 tools**,
each taking an `action` plus action-specific `args`:

| Tool | Actions |
|------|---------|
| `tracepass_products` | `list`, `get`, `create`, `update` |
| `tracepass_passports` | `list`, `get`, `get_by_serial`, `create`, `suspend`, `archive`, `get_qr` |
| `tracepass_passport_fields` | `update` |
| `tracepass_passport_parties` | `set`, `remove` |
| `tracepass_epcis` | `export`, `capture`, `capture_job`, `query` |

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

## Prompts

Reusable DPP workflows the client surfaces as slash-commands:

- `audit_passport` — review a passport for completeness and
  compliance readiness
- `onboard_product` — create a product and its first passport
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

## License

MIT
