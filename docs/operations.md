# Operations runbook

## Pilot deployment

1. Pin a reviewed `v0.4.x` source/tag and verify lockfile provenance.
2. Use Node 22.16+ and pnpm 10.15.0 in an isolated build environment.
3. Run every documented gate and retain the scorecard, SBOM inventory, audit result, and package
   manifests.
4. Create one service identity per tenant/user mapping. Configure deny-by-default actions.
5. Use separate opaque storage namespaces. Put artifacts, audit, memory, and backups on encrypted
   volumes; inject AES keys from KMS when application-layer encryption is required.
6. Keep remote MCP and channel integrations disabled for the initial local pilot.
7. Allowlist exact writable files, commands/args, routes, and required network endpoints.
8. Run `smart-ui setup --target <repo> --agent-memory`, start the stdio MCP server under the target
   host, and run `smart-ui doctor`.
9. Exercise a validation-only canary, inspect the offline report, then dry-run one repair.
10. Enable real writes for a small reviewed cohort and monitor failures, rollback rate, latency,
    artifact volume, and audit-chain health.

## Health and readiness

`smart-ui setup --target <repo> --agent-memory --json` provisions the pinned Playwright Chromium
revision when needed, launches it, and runs a disposable Agent Memory SQLite persistence canary.
The canary writes, closes, reopens, reads, deletes, and removes its temporary store. No external SQL
service is involved.

`smart-ui doctor --target <repo> --json` checks runtime, framework, strict config, and a real
Chromium launch without downloading anything. Readiness also requires the target dev server to be
reachable at an allowlisted route before validation. Verify audit logs regularly with
`smart-ui audit-verify`.

## Backup and restore

Use `LocalBackupManager` only from an authenticated administrative adapter. Stop writers, create a
scope-bound backup, copy it to controlled storage, and verify hashes. For encrypted backups, retain
the key identifier and restore it through KMS; keys are never written into Smart UI manifests.

Restore drills use a new empty destination, the exact same scope, and explicit actor approval. The
restore verifies every plaintext hash and refuses to overwrite an existing destination. After a
successful drill, validate memory export, artifact manifests, audit chain, and one read-only run.

## Retention and deletion

Configure separate artifact/report/audit/memory windows. `RetentionManager` only walks a declared
managed root, rejects symlinks, and can retain matching legal-hold paths. Run deletion jobs with a
single writer, audit actor/scope/count, verify requested records are absent, and retain the audit
event according to policy. Organization administrators define legal holds and erasure exceptions.

## Incident response

1. Disable mutating MCP tools, channel integrations, external models, and browser networking.
2. Preserve audit logs and relevant content hashes under the approved incident/legal-hold process.
3. Rotate host/model/channel credentials and encryption keys through their owners.
4. Verify audit chains, package hashes, configuration, endpoint/write/command policy, and recent
   baseline approvals.
5. Restore to a clean namespace from a verified backup if integrity is uncertain.
6. Run security, unit, E2E, evaluation, dependency, secret, and package gates.
7. Re-enable validation-only canaries before writes.
8. Document root cause and add a regression/threat-model test.

## Upgrade and rollback

Read `CHANGELOG.md`, back up governed stores, build/package from the lockfile, run all gates, and canary
validation before mutation. Config version 1.0 accepts unversioned Phase 3 files through explicit
`migrateConfig`; unknown future versions fail closed.

Rollback by disabling MCP/channel integration, restoring the prior package/tag and compatible
configuration, and restoring data only when a migration changed it. Never overwrite a live store
during rollback; restore to a new path, verify, then switch the service atomically at the deployment
layer.
