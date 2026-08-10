# Changelog

## Unreleased

- Added an agent-powered Studio generation engine (default) driven by the connected `smart-ui` MCP
  chat agent through a contained file-queue bridge (`studio-agent-bridge`), plus the
  `list_studio_authoring_requests` and `submit_studio_authored_html` MCP tools, an `awaiting-agent`
  Studio phase, and a ready-to-paste prompt carrying the workspace path and run ID.
- Added `authoringCanvasGuidance` so authored HTML is anchored to the design's exact render/compare
  canvas (size, aspect ratio, and scale) per layout intent.
- Simplified Studio startup: `--workspace` is now optional and defaults to `<cwd>/.studio-workspace`
  inside the MCP root, and the dedicated workspace is initialized automatically.
- Added a planned confirm-then-improve refinement loop design at
  `docs/confirm-then-improve-plan.md`, including deferred larger improvements.
- Added the private React/Vite local Studio build input and packaged `smart-ui studio` command with
  dedicated-workspace initialization, headless loopback startup, health checks, upload/preferences/
  progress/review workflow, cancellation, persisted recovery, retention, and verified single-run
  deletion.
- Added capability-cookie, CSRF, exact Host/Origin/method/media-type, streaming upload, separate
  preview origin, manifest download, escaped source, concurrent artifact isolation, and shutdown
  controls with adversarial and real-Chromium coverage.
- Added a separate 12-scenario owned SVG generation corpus, twice-measured repeatability evidence,
  deterministic scorecard without an overall quality score, Studio bundling ADR, and packaged clean
  consumer checks.

## 0.4.2 - 2026-08-10

- Added the Phase 2 stdio MCP SVG-generation workflow with compact inspection, paged normalized
  context, generation/retrieval/report tools, a guide/prompt, progress/cancellation propagation, and
  a separately approved exact-manifest export.
- Added optional user-approved host semantic HTML/CSS/SVG proposals behind parse5/PostCSS output
  policy, isolated deterministic comparison against the built-in fallback, non-regression/repeated
  output rejection, immutable proposal passes, and host/proposal provenance.
- Expanded deterministic semantic/layout candidates, enabled CLI semantic mode, and added narrow
  target-size/focus-order robustness findings without scoring desktop SVGs as narrow fidelity.

- Added targeted compact MCP findings with DOM locators, confidence, expected/actual values, deltas,
  category-balanced prioritization, sensitive-value redaction, and filtered pagination through
  `get_findings`.
- Added an exact-approval host repair bridge so an MCP host agent can submit one bounded full-file
  patch batch for repository checks, Chromium revalidation, deterministic retention, or rollback;
  the existing background-color heuristic is now an explicit narrow fallback.
- Persisted visual mismatch on every new pass and updated convergence to retain measurable raster
  improvement before the binary threshold passes while rejecting check-score or visual regressions.
- Added visual mismatch to offline reports and expanded MCP, repair, backward-compatibility,
  redaction, pagination, approval, and real-Chromium verification coverage.

## 0.4.1 - 2026-08-09

- Added public npm package metadata, package-level usage documentation, and an explicit publication
  readiness gate that rejects missing licensing and non-registry production dependencies.
- Replaced the newly vulnerable general-purpose image dimension dependency with bounded PNG, JPEG,
  WebP, and SVG header parsing plus a local-evidence byte budget.
- Added the versioned plan for the separate Smart UI Validator Windows desktop and installer product.
- Added the supported `smart-ui setup` workflow for package-local Chromium provisioning, real
  browser launch diagnostics, and an optional disposable Agent Memory SQLite persistence canary.
- Replaced the development-only Agent Memory Git dependency with the exact public
  `dev-agent-memory@0.4.1` npm release.
- Adopted the MIT license, finalized the unscoped `smart-ui-validator`,
  `smart-ui-validator-core`, and `smart-ui-validator-mcp` package names, removed personal metadata
  from the public tree, and added a repeatable privacy gate.
- Updated CI to install Chromium through the renamed core package; the public Agent Memory package
  now supplies the TypeScript declarations that the former Git tarball lacked on clean runners.

## 0.4.0 - 2026-08-06

- Added bounded production React/Angular framework discovery and representative Angular fixture.
- Added responsive/state, accessibility, dynamic-region, regression baseline, and convergence evidence.
- Added stable stdio MCP server plus Codex, Claude Code, Copilot, and optional OpenClaw setup contracts.
- Added non-overwriting CLI RunRecord output and workspace/symlink containment for MCP filesystem
  inputs.
- Added isolation, authorization, encryption integration, audit, retention, backup/restore, telemetry,
  evaluation, CI, security, packaging, release, threat-model, and operations controls.

## 0.3.0 - 2026-08-06

- Added governed interaction and memory, Agent Memory SQLite persistence, lifecycle CLI, and safety
  tests.

## 0.2.0 - 2026-08-06

- Added deterministic comparison, browser evidence, bounded repair, Figma/Chrome MCP contracts, and
  offline reports.

## 0.1.0 - 2026-08-06

- Added host-neutral core/CLI, schemas, React fixture, isolated browser capture, artifact store, and
  policy boundary.
