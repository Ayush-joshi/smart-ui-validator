# Security boundary

Phase 1 is local-first and treats design text, images, repository files, DOM, and browser content as
untrusted data. It does not interpret content as tool instructions.

- Paths resolve against a declared target root; traversal is rejected.
- Source writes require an exact file allowlist. Dry-run performs no target source writes.
- Processes use executable and argument arrays, fixed cwd, captured output, and timeouts.
- Capture launches Chromium in a fresh context and never attaches to a normal user profile.
- Run records reference content-addressed files and do not embed base64 images.
- Structured errors do not intentionally record environment variables or headers.

Current limitations: browser network hosts are not yet allowlisted, artifacts are not encrypted,
concurrent manifest writers are not coordinated across processes, and retention is manual. Do not use
Phase 1 against untrusted internet applications or repositories containing secrets.
