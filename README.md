# TracePass MCP Server

[![Listed on Glama](https://glama.ai/mcp/servers/malinoto/tracepass-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/malinoto/tracepass-mcp-server)
[![smithery badge](https://smithery.ai/badge/malinoto/tracepass-mcp-server)](https://smithery.ai/servers/malinoto/tracepass-mcp-server)

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

## Authentication

The server accepts **either** of TracePass's two v1 auth methods on the
same `Authorization: Bearer …` header — it forwards whatever you send to
the API, which decides. Pick the one that fits how you're connecting:

| | **API key** | **OAuth 2.0** |
|---|---|---|
| Best for | A single user, scripts, server-to-server | AI assistants / apps acting **on a user's behalf** |
| What you send | A static `tp_…` key as a Bearer token | A scoped access token obtained via the OAuth flow |
| Setup | Mint at **Developer → API Keys** | The user clicks **Connect** and approves scopes |
| Scope | All-or-nothing (the whole workspace) | Exactly the scopes the user granted; revocable |
| Works with | Hosted **and** local (npx) | Hosted endpoint only (needs a browser consent step) |

**Which should an AI assistant use?** If your MCP client supports OAuth
(Claude.ai, ChatGPT, and others), prefer **OAuth** — the user authorizes
the connection once on a TracePass consent screen, you never handle a
secret, and access is least-privilege and revocable. If your client only
takes a header/token, use an **API key**.

### OAuth 2.0 (recommended for hosted clients)

No config beyond pointing your client at the hosted endpoint — discovery
is automatic. On the first unauthenticated request the server returns a
`401` whose `WWW-Authenticate` header carries a `resource_metadata` URL
(RFC 9728) pointing at `/.well-known/oauth-protected-resource`, which
names the TracePass authorization server. The client runs the standard
**authorization-code flow with PKCE** (`/api/oauth/authorize` →
`/api/oauth/token`), the user approves scopes, and the client stores +
refreshes the token. If you distribute your own client, register an app
under **Developer → OAuth Apps** to get a `client_id`; many hosted
clients self-register via Dynamic Client Registration automatically.

Request only the scopes you need, e.g. `passports:read passports:write
offline_access`. Users manage connected apps (and revoke) under
**Developer → OAuth Apps → Connected Apps**.

### API key

Mint a `tp_…` key under **Developer → API Keys** and send it as a Bearer
token.

**Hosted:**

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

**Local (npx / stdio)** — the local subprocess can't do an interactive
OAuth consent step, so it's API-key only, via the `TRACEPASS_API_KEY` env:

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

The TracePass v1 API operations are grouped into **6 tools**.
Each takes an action enum plus action-specific arguments. The tools are:

- `tracepass_products` - manage the product catalogue (list, get, create, create_batch, update, archive products).
- `tracepass_passports` - manage Digital Product Passports (list, get, compliance check, registry-readiness check, get/set condition flags, create, suspend, archive, get QR, list snapshots, get snapshot), by id or by serial. Passports are identified via GS1 or four additional EN 18219 schemes (iso15459, iec61406, did, doi); battery passports accept only gs1 and iso15459 (Art. 77(3)). **Condition flags** are approved yes/no facts (e.g. battery: `hasBMS`, `rechargeable`, `externalStorageOnly`, `isStationaryBess`) that gate conditional legal duties — setting an approved flag may make additional fields required and block publishing if those fields are empty.
- `tracepass_passport_fields` - update a passport's category-specific data fields, by id or by serial.
- `tracepass_passport_parties` - set or remove a passport's economic-operator parties (manufacturer, importer, etc.).
- `tracepass_epcis` - export, capture, and query a passport's GS1 EPCIS 2.0 supply-chain events.
- `tracepass_templates` - list and get the DPP category field schemas, each field traced to the EU instrument that mandates it.

Each tool's full action set:

| Tool | Actions |
|------|---------|
| `tracepass_products` | `list`, `get`, `create`, `create_batch`, `update`, `archive` |
| `tracepass_passports` | `list`, `get`, `get_by_serial`, `compliance`, `registry_readiness`, `get_condition_flags`, `get_condition_flags_by_serial`, `set_condition_flags`, `set_condition_flags_by_serial`, `capture_measurements`, `capture_measurements_by_serial`, `list_measurements`, `list_measurements_by_serial`, `latest_measurements`, `latest_measurements_by_serial`, `create`, `suspend`, `suspend_by_serial`, `archive`, `archive_by_serial`, `get_qr`, `get_qr_by_serial`, `list_snapshots`, `get_snapshot` |
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

A **`compliant` verdict means this passport satisfies the rules encoded here**,
not *this product may be placed on the market*. The field specifications are
hand-authored from the regulations, not an official EU artefact, and delegated
acts are still landing. It is not legal advice.

### Second-life batteries

A repurposed, remanufactured or reused battery needs a **new** passport
linked to the original one(s) (Battery Regulation Art. 77(7)). Pass a
`lineage` block to `tracepass_passports` `create`:

```json
{ "predecessors": [ { "internalPassportId": "<your original passport id>", "trigger": "repurposing" } ] }
```

A predecessor is named by `internalPassportId` (one of your own passports)
or by its resolvable `identifier`. `trigger` is one of
`preparation_for_reuse`, `preparation_for_repurposing`, `repurposing` or
`remanufacturing`. The platform derives `batteryStatus` from the
triggers, stores the block immutably, and links your own originals back
to the new passport (`successors`). A battery placed on the market before
18 Feb 2027 has no original passport: send an empty list with
`noPredecessorReason`. Rule violations return 422 with the rule code.

### Battery measurements (living record)

`capture_measurements` pushes over-life data from your own equipment into a
published battery passport: state of health, fades, cycle counts, dynamic
values, state of charge, negative events, temperature history (Battery
Regulation Annex XIII point 4). Every measurement is kept; the newest per
field becomes the passport's current value and sets `dynamicDataAsOf`.
`list_measurements` and `latest_measurements` read them back.

They are metered against the plan's monthly measurement allowance, not the
daily write budget. Paid plans keep counting past the allowance at no
charge; the Free plan stops at its allowance. Reading a passport is never
metered.

### A note on writes

Some actions **cost money or are irreversible** — the server's tool
descriptions tell the model so:

- **`tracepass_passports` `create`** consumes billable DPP slots.
  Over-quota creation incurs a per-passport overage charge; the tool
  surfaces a 402-style message and only proceeds with
  `args.confirmOverage: true` after the user agrees.
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
- `tracepass://passport/{id}/registry-readiness` — a mechanical pre-submission check modelled on the EU DPP Registry's formal gate: mandatory-field presence, formatting, a resolvable public link, item-level granularity (no commodity-code check: a battery passport's registration identifier is not entered in the customs declaration). Not the substantive compliance verdict, and not a prediction of the real registry's response — its registration API has no published spec. Battery only.
- `tracepass://passport/{id}/snapshots` — the snapshot history of a passport (newest first): a snapshot on publish and after every change to a non-draft passport; each entry carries version, reason (e.g. published, field_edit, status_change, baseline), actor, snapshotAt, contentHash, hashValid (re-verified on read), restorable flag, and field count.
- `tracepass://templates` — all 13 DPP category field schemas
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

## For suppliers: answering a data request

A second, separate endpoint serves **suppliers** who receive a TracePass data
request. It is not part of the tools above. The request email carries a
personal address:

```
https://ai.tracepass.eu/supplier/mcp/<token>
```

Add it to an AI assistant as a custom connector. For clients that can set
headers, `https://ai.tracepass.eu/supplier/mcp` with
`Authorization: Bearer <token>` works too. The token authorises that one
request only; there is no account and no OAuth. The assistant can then:

| Tool | What it does |
|---|---|
| `get_request` | Start here: who is asking, for which product, and every field asked for, each with its meaning, unit, format and legal source; plus answers already sent and the review outcome |
| `validate_answers` | A dry run: what would be stored, which keys were not requested, and what does not fit. Writes nothing |
| `get_upload_command` | The best way to attach a datasheet or certificate when the assistant can run shell commands: returns a `curl` command that uploads the file from disk and prints a `documentId` to cite (PDF, Office, CSV, PNG/JPEG/WebP) |
| `upload_evidence` | Attach a very small file (a few kilobytes) inline as base64; prefer `get_upload_command`, or cite a URL or note |
| `submit_answers` | Send answers with evidence per value to the requester's human review; can be repeated (answers merge) until reviewed |
| `get_review_status` | Whether the requester has reviewed them, the outcome, accepted fields, and when the link expires |

Answers go to the requester's human review; they never publish anything on
their own.

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
