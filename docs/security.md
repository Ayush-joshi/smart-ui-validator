# Security boundary

Smart UI treats design text/images, repository content, DOM/browser content, memory, MCP input, and
channel content as untrusted evidence. None can authorize tools, writes, commands, endpoints, models,
memory scope, baseline changes, or channel output.

Implemented controls:

- Strict versioned schemas and bounded file/evidence/context/pass/time processing.
- Target containment, exact write allowlists, symlink checks, exact command/argument allowlists,
  `shell:false`, output caps, dry-run, regression checks, and rollback.
- Isolated temporary Chromium contexts, fixed environment, blocked service workers, external network
  deny-by-default, origin/path allowlists, and no personal browser attachment.
- Content-addressed artifacts with realpath/hash checks; run records reference rather than embed
  binary evidence.
- Recursive secret/header/query/credential redaction before persisted logs, reports, audit, memory,
  and channel text; local secret scanning in CI.
- Tenant/user/repository/project context validation, opaque storage namespaces, deny-by-default
  action authorization interface, and cross-scope memory tests.
- Optional injected AES-256-GCM with scope-bound AAD. Keys must come from KMS/secret management and
  are never persisted by Smart UI.
- Append-only audit interface with sequence and SHA-256 hash chain plus verification.
- Human-attributed visual-baseline approval, scope-bound backup, plaintext hash verification,
  non-overwriting restore, retention/legal-hold extension, and export/deletion APIs.
- MCP read/write/destructive annotations, explicit repair/memory approvals, cancellation, compact
  outputs, no generic shell, and no remote transport by default.
- OpenClaw/Slack workspace-to-tenant mapping, origin-thread/user approval, event deduplication,
  inbound redaction, and deny-by-default source/screenshot/design/memory output policy.
- Telemetry, learning, remote memory, remote design, external models, browser networking, remote MCP,
  and channel integration disabled by default through configuration/admin policy.

Deployment responsibilities and current limitations:

- Local JSON, SQLite, artifacts, reports, baselines, and audit logs are plaintext unless the
  deployment uses encrypted storage or the encryption interface. OS permissions/KMS/key rotation are
  external responsibilities.
- The JSON governance and artifact manifests are not coordinated for multiple concurrent writers.
- Hash-chained local audit is tamper-evident, not immutable; ship it to access-controlled/WORM storage
  when required.
- Redaction is defense in depth, not full DLP or personal-data classification.
- Live Chrome MCP cannot enforce Playwright request interception equivalently. Live Figma/Chrome MCP,
  hosts, external models, Slack, remote transport, and enterprise identity are not CI-certified.
- The included local stores remain intended for a controlled single-user/local pilot. A multi-node
  service needs transactional stores, durable idempotency, centralized authorization, rate limiting,
  encrypted transport, and operational monitoring.
- No certification or legal/regulatory compliance is claimed.

See [threat model](threat-model.md) and [operations](operations.md).
