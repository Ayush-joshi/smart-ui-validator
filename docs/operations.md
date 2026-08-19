# Operations runbook

## Pilot deployment

1. Pin a reviewed `v0.5.x` source/tag and verify lockfile provenance.
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

For the SVG MCP pilot, bind `SMART_UI_MCP_ROOT` to one dedicated workspace, call `inspect_svg` before
generation, keep compact responses as the default, and review the accepted manifest/report before a
separate `export_generation` approval. Run `pnpm test:mcp:stdio` after every build. A missing
generation context after host restart is recovered with `get_generation` using the original
workspace, generation ID, and artifact base; do not broaden the trusted root. Generation preview
servers are short-lived and close on completion, failure, timeout, or cancellation.

For the local Studio pilot, initialize a new empty dedicated root and start headless by default:

```bash
smart-ui studio --workspace /absolute/smart-ui-studio --init-only --json
smart-ui studio --workspace /absolute/smart-ui-studio --health-check --json
smart-ui studio --workspace /absolute/smart-ui-studio
```

To enable the Validate UI work type, declare the exact repository root at process startup. The
browser cannot select or widen this root:

```bash
smart-ui studio \
   --workspace /absolute/smart-ui-studio \
   --target /absolute/react-or-angular-repository
```

Use `--review-task /absolute/task.json` to import a hash-verified generation or validate-UI task into
the shared Review screen.

Startup refuses `/`, a drive root, the user home directory, symlink roots, and unmarked non-empty
directories. The marker, `runs/` directory, and bounded handoff-task association registry are the
only shared workspace state. Each
`runs/run-<uuid>/` contains a server-named upload, a separate inspection artifact store, a new
generation artifact store, and a bounded `studio-run.json` pointer. The core `GenerationRecord` in
the generation store is authoritative; the pointer only enables recovery. Studio binds only to
`127.0.0.1`, prints no cookie/CSRF capability, collects no telemetry, and accepts no remote clients.

Validate-UI uploads are staged under a server-selected UUID directory inside the configured target,
revalidated and copied into immutable task evidence by core intake, then removed from staging.
Routes, presentation paths, and writable files remain target-relative and exact. Task polling trusts
only verified `state.json` revisions. Removing a CLI-imported task from Studio deletes only its local
association; it never deletes task or repository files.

Studio starts on the Work type screen and does not automatically select recovered work. Persisted
runs and task associations remain available under **Recent work**. **Reset workflow** clears only the
active browser workflow and leaves persisted evidence intact. The separately confirmed **Clear local
history** action deletes all Studio-owned run directories and unregisters Studio task associations;
it does not delete target repository files or the underlying task files.

`--retention-hours` defaults to 24 hours and is bounded from one second to 30 days. Expiration and
the UI's **Delete this run** action close its preview, cancel in-flight work, verify the exact child
of `runs/`, remove only that directory, and verify absence. **Clear local history** applies the same
bounded run deletion to every Studio run and clears only the association registry. For a support
bundle, retain the relevant record/report/manifest hashes and redact the dedicated workspace path;
never include the process cookie, CSRF token, raw unsafe upload, or unrelated runs. Local storage is
plaintext unless an OS or desktop wrapper supplies encryption.

## Health and readiness

`smart-ui setup --target <repo> --agent-memory --json` provisions the pinned Playwright Chromium
revision when needed, launches it, and runs a disposable Agent Memory SQLite persistence canary.
The canary writes, closes, reopens, reads, deletes, and removes its temporary store. No external SQL
service is involved.

`smart-ui doctor --target <repo> --json` checks runtime, framework, strict config, and a real
Chromium launch without downloading anything. Readiness also requires the target dev server to be
reachable at an allowlisted route before validation. Verify audit logs regularly with
`smart-ui audit-verify`.

Studio `--health-check --json` checks the public engine constructor, browser adapter, packaged
client/server assets, loopback binding, a disposable contained write, and runs-directory
containment. It starts and closes the local server without opening a browser.

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
Generation records and their per-run artifact directories use the same retention policy. Deletion
authorization is the distinct `generation:delete` action; this phase does not expose a generic MCP
delete tool.

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
