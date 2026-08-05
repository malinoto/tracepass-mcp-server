# Contributing

Thanks for taking the time. This is a small project maintained by one person, so
the most useful thing you can do before writing code is **open an issue first** —
especially for anything that changes the tool surface. It may already be a
deliberate decision, and it's cheaper to find that out before you build it.

## Where a change belongs

This package is a **thin MCP client over the TracePass v1 REST API**. It calls the
API over HTTP rather than reaching into a database, so the API owns authentication,
plan-gating, the overage flow and rate limits.

That means:

- **A field the API doesn't return can't be added here.** The change starts in the
  TracePass platform; this package only exposes what v1 already serves.
- **Bugs in API *behaviour*** (wrong data, wrong status code) are platform issues.
  Report them to support@tracepass.eu — a release of this package won't fix them.
- **Bugs in *this* package** — wrong endpoint, bad argument validation, a tool whose
  description doesn't match what it does — belong here.

## Setup

```bash
npm ci
npm run build
```

Node 20 or newer (`engines` in `package.json`).

To try it against a real account, set `TRACEPASS_API_KEY` and run the stdio form:

```bash
npm run start:stdio
```

Use a key from a **Free-plan account** for development. Creating passports is
billable, and some actions are irreversible — the tool descriptions say which.

## Before opening a PR

```bash
npm run lint && npm run typecheck && npm test
```

All three must pass; the publish workflow runs the same four steps plus `build`.
There is currently **no CI on pull requests**, so please run them locally — a
maintainer will otherwise find out at release time.

## Adding an endpoint

The v1 surface is grouped into **six resource tools**, each taking an `action` enum
plus `args`. This is deliberate: exposing ~29 flat tools would swamp a model's tool
list and slow tool selection.

So: **add an action to the right existing tool** rather than a seventh tool, unless
you are genuinely introducing a new resource. Concretely:

1. Add a per-action Zod schema to `SCHEMAS` in `src/tools.ts`.
2. Add the action to that tool's `action` enum **and** document it in the tool's
   `description` — the description is the model's only documentation, so state what
   `args` are required and call out anything billable or irreversible.
3. Add the `case` to the handler, validating with `parseArgs(SCHEMAS.yourSchema, …)`.
4. Update the action count in `README.md` (two places) and `CLAUDE.md`.

The README matters more than it looks: external catalogues parse it to extract the
tool list, and one only reads the **first 8000 characters** — keep the tool table
early.

## Conventions worth keeping

- **402 / 403 / 429 are results, not exceptions.** They're surfaced as readable
  `isError: true` text so a model can explain them to the user and, for 402, retry
  with `confirmOverage: true`. Don't let them throw.
- **Resources are read-only** (`tracepass://…`) — they may do GET I/O but must never
  mutate or trigger a billable call. **Prompts are pure** — static text, no I/O.
- **Never log or store a credential.** The `Authorization` header is forwarded to
  the API unchanged; that's the whole contract.

## Security

Please don't open a public issue for a vulnerability — see
[SECURITY.md](SECURITY.md).

## Licence

By contributing you agree your contributions are licensed under the MIT Licence
that covers this project.
