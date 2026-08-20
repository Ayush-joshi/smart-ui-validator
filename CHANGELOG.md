# Changelog

## Unreleased

## 0.5.1 - 2026-08-20

- Updated documentation to reflect that Validate UI workflows now include a visual interface via Smart UI Studio.

## 0.5.0 - 2026-08-20

- Added host-neutral persistent `GenerationTask` and `ImplementationTask` workflows shared by CLI,
  MCP, Studio, external agents, and humans. Tasks pin bounded evidence, exact writable locations,
  hashes, revisions, generated instructions, and explicit lifecycle state.
- Added `smart-ui generation prepare/review`, `smart-ui validate-ui prepare/review`, and shared
  `smart-ui task status/accept/cancel` commands. CLI handoff no longer invokes or waits for a model;
  the removed `smart-ui generate --engine agent` path returns migration guidance.
- Added five task-backed MCP tools for listing and reading handoffs and submitting exact approved
  generation or React/Angular implementation files. CLI, MCP, and Studio submissions converge on
  immutable deterministic review attempts and explicit acceptance.
- Reworked Studio around Generate UI and Validate UI work types with a shared Inputs, Preferences and
  boundaries, Handoff, and Review flow. Connected MCP and external agent/human continuations use the
  same persistent task, while imported task removal never deletes task or repository files.
- Added validate-UI review indexes with ordered viewport/state evidence, explicit source-fidelity,
  alternate-reference, and unscored robustness classifications, plus exact allowlisted UTF-8 file
  snapshots and tamper/concurrency/containment controls.
- Added structured design context, presentation/canvas intent, PNG plus source-context intake,
  generated agent instructions, Studio setup diagnostics, and task recovery across the CLI, MCP,
  Studio, records, reports, and content-addressed artifacts.
- Attached hash-verified rendered PNG evidence to Studio authoring requests. Each request now
  carries the rendered design image, and revision rounds also carry the previous round's render,
  pixel difference, and overlay; `list_studio_authoring_requests` returns them as MCP image content
  within a bounded inline budget so the authoring agent can see the design instead of only parsing
  SVG paths.
- Fixed a confirm-then-improve dead end. The authoring queue now keeps a durable per-run high-water
  mark of issued rounds, and Studio derives the next round from it, so a rejected, failed, or
  abandoned round reliably queues the next request instead of failing with
  `Studio authoring round N is stale or duplicated` and leaving no pending request.
- Fixed improvement rounds failing with `Artifact root must be a new empty directory`. Each Studio
  authoring round now generates into its own `runs/<id>/artifacts/round-<n>` root, and record
  selection, downloads, evidence, previous-round evidence, and recovery resolve artifacts from the
  owning round's root.
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
