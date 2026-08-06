# Release process

Smart UI uses semantic versioning. Schema compatibility and migration behavior are public
commitments; breaking schema semantics require a major version and an explicit migration.

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

Rollback uses the previous verified tarball/tag and the operations runbook. Package publication,
deployment, credentials, Git pushes, and external messages are always separately authorized actions.
