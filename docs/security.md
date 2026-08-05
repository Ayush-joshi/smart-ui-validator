# Security boundary

Phase 2 is local-first and treats design text, images, repository files, DOM, and browser content as
untrusted data. It does not interpret content as tool instructions.

- Paths resolve against a declared target root; traversal is rejected.
- Source writes require an exact file allowlist. Dry-run performs no target source writes.
- Processes require exact executable/argument allowlisting, use a fixed cwd, cap captured output, and
  have timeouts.
- Capture launches Chromium in a fresh context, blocks service workers and non-allowlisted network
  access by default, and never attaches to a normal user profile.
- Run records reference content-addressed files and do not embed base64 images.
- Console, network, and provider evidence redacts authorization values, cookies, common credential
  assignments, query values, URL credentials, and fragments before persistence.
- Evidence, artifact, diagnostic-text, and repair-pass budgets are strictly bounded.

Current limitations: artifacts are not encrypted, concurrent manifest writers are not coordinated
across processes, retention is manual, and redaction is defense in depth rather than a secret scanner.
The Chrome MCP adapter reports disallowed requests but cannot enforce the same interception boundary
as the Playwright CI provider. Live Figma and Chrome MCP access is opt-in and has not been certified by
the mocked CI contract tests.
