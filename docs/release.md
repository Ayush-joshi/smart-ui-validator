# Release process

Smart UI uses semantic versioning. Schema compatibility and migration behavior are public
commitments; breaking schema semantics require a major version and an explicit migration.

The public-registry sequence, current blockers, package order, clean-consumer tests, and trusted
publishing setup are defined in [`npm-publishing.md`](./npm-publishing.md). The Windows desktop
product consumes only releases that pass that contract.

1. Update `CHANGELOG.md` and package versions.
2. Run the complete README verification sequence from a clean install.
3. Review production dependencies, licenses, `pnpm audit`, local secret scan, SBOM, and package dry
   runs. Confirm tarballs exclude tests, fixtures, source maps, caches, browser binaries/profiles, and
   private evidence.
4. Review the measured evaluation scorecard and live/config-only integration matrix.
5. Tag `vX.Y.Z`. The workflow builds candidate tarballs and uploads them; it does not publish.
6. In a separately protected environment, verify tarball hashes/provenance and require release-owner
   approval before registry publication.
7. Canary `doctor`, inspection, and validation-only before enabling repair.
8. Canary one safe SVG generation and review its accepted manifest, fidelity/robustness
   classifications, report, and ZIP before enabling MCP export.
9. From the packed CLI, initialize a disposable Studio workspace. Run its health check with
   `smart-ui studio --health-check --json`, then verify the bundled assets, real browser adapter,
   loopback binding, write access, and containment checks before declaring the CLI package complete.

Rollback uses the previous verified tarball/tag and the operations runbook. Package publication,
deployment, credentials, Git pushes, and external messages are always separately authorized actions.
