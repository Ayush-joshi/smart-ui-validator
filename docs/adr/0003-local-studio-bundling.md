# ADR 0003: package local Studio inside the CLI distribution

Status: Accepted

Date: 2026-08-11

## Context

The SVG generation plan requires an optional graphical host without adding a hosted backend or a
second generation implementation. A monorepo development server working only from source would not
prove that npm consumers receive compatible Studio assets. Publishing another package would add a
fourth version surface before it enforces a useful public boundary.

The loopback HTTP boundary also needs stronger controls than the short-lived generated-preview
server because a regular browser tab and unrelated local pages can issue requests to loopback.

## Decision

Keep `@smart-ui/studio` private. Build its TypeScript server and React/Vite client first, then copy
only `server.js`, `public/index.html`, and hashed production JavaScript/CSS into the CLI's explicit
`dist/studio` subtree. `smart-ui studio` dynamically imports that packaged server. The CLI has a
workspace-only development dependency on Studio to enforce topological build order; the packed
manifest does not expose it as a production dependency.

The server imports public `smart-ui-validator-core` construction APIs and never shells out to the
CLI or imports MCP internals. Inspection and generation receive separate per-run artifact stores.
CLI, MCP, and Studio preserve the same `DesignBundle`/`GenerationRecord` schema; Studio contributes
only the additive `smart-ui-studio` provenance value.

Bind only `127.0.0.1` on an ephemeral port. Protect the process with an unlogged random HTTP-only
SameSite cookie plus a distinct CSRF token, exact Host/Origin/method/content-type checks, no CORS,
bounded streaming upload, opaque run IDs, manifest-routed downloads, and a separate generated
preview origin. Render generated source only as escaped text spans. On shutdown, stop accepting
requests before canceling tasks and closing previews.

## Rejected alternatives

- A separately published Studio package: adds independent versioning and compatibility risk without
  a current consumer boundary.
- Calling the CLI and parsing JSON: duplicates host behavior and weakens cancellation, progress,
  typed errors, and public-core compatibility.
- Importing MCP server routes: couples a local browser host to stdio schemas and approvals.
- A Vite development server in the shipped command: exposes source/development behavior and makes
  clean-consumer packaging unverifiable.
- Serving generated preview in the Studio origin or injecting it with `innerHTML`: collapses the
  execution boundary and risks active content in the privileged application document.

## Consequences

Root build order and package checks must verify the copied Studio subtree. Clean-consumer tests must
start the packaged server and health check. Studio is local-only and plaintext; a future hosted or
separately published product requires a new ADR covering authenticated tenants, remote transport,
encryption, quotas, abuse controls, and exact-version compatibility.
