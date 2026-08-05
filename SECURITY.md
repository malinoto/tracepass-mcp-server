# Security Policy

## Reporting a vulnerability

Please report security issues privately to **support@tracepass.eu** rather than
opening a public issue. Include enough detail to reproduce — a request/response
pair or a minimal script is ideal.

You should get an acknowledgement within **3 working days**. TracePass is a small
team, so please allow reasonable time for a fix before public disclosure; we will
tell you when a patch ships and credit you unless you'd rather stay anonymous.

## Supported versions

Only the **latest published version** of `tracepass-mcp-server` receives security
fixes. Older versions are not patched — upgrade before reporting an issue you can
only reproduce on an old release.

## Scope

This package is a thin MCP client over the TracePass v1 REST API. That shapes
what is and isn't a vulnerability here:

**In scope** — anything in this package: credential handling, the auth
pass-through, argument validation, dependency vulnerabilities, or a tool that
performs an action its description doesn't disclose.

**Out of scope** — the hosted TracePass API and platform. Those are separate
systems; report issues there to the same address, but they aren't fixed by a
release of this package.

## What this package does with your credentials

Worth stating plainly, because it's the most common security question:

- The API key (`TRACEPASS_API_KEY`, stdio) or `Authorization: Bearer` header
  (hosted) is **forwarded to the TracePass v1 API unchanged**. This package never
  inspects, stores, logs, or transforms it.
- Tools call the v1 REST API over HTTP rather than reaching into a database, so
  every request is subject to the same authentication, authorisation,
  plan-gating and rate-limiting the API applies to any other client. There is no
  privileged path through this package.
- MCP discovery methods (`initialize`, `tools/list`, `prompts/list`,
  `resources/list`) are served **without** a credential so catalogues can
  introspect the server; every method that touches the API requires one. A `401`
  from the hosted endpoint before a token is presented is the documented
  RFC 9728 challenge, not a fault.
