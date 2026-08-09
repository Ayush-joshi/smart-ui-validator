# Changelog

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
