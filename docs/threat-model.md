# Threat model

## Assets

Protected assets include target source, design evidence, screenshots, DOM/style evidence, memory,
identity/scope, audit logs, credentials, reports, baselines, browser sessions, model context, and
approval decisions.

## Trust boundaries

- CLI/MCP/channel input to strict schemas.
- Target repository and design/DOM/memory text to advisory evidence.
- Core to filesystem/process/network policy.
- Core to isolated browser context.
- Local process to Agent Memory SQLite or other storage.
- Local browser to the loopback Studio origin, then to a separate generated-preview origin.
- Optional channel/remote transport to authenticated actor and tenant mapping.
- Deployment storage to injected encryption/KMS and backup systems.

## Primary threats and mitigations

| Threat                                                                                     | Mitigation                                                                                                                                      | Residual risk                                                                        |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Prompt injection in design, SVG text, host instructions, DOM, repository, memory, or Slack | Inputs are labeled untrusted; only typed data reaches providers; content never changes policy; poisoning patterns and budgets are enforced.     | A production model adapter still needs prompt isolation and output validation.       |
| Active or exfiltrating generated output                                                    | Strict SVG intake, parsed HTML/CSS policy, exact declared manifest, restrictive CSP, isolated loopback origin, and browser network deny.        | Parser/runtime advisories still require dependency review and prompt upgrades.       |
| Host proposal laundering or self-scoring                                                   | Separate user approval, exact files, core rendering/scoring, deterministic fallback comparison, immutable accepted/reverted passes.             | Semantic quality still needs human review when visual measures are equal.            |
| Generation/export approval confusion                                                       | Generation writes only a new core run; export requires accepted manifest hash, full exact path list, exact empty destination, and new approval. | A compromised authorized host can still request misleading user approval text.       |
| Cross-site request to loopback Studio                                                      | Exact Host/Origin/method/media type, SameSite HTTP-only capability cookie, separate CSRF token, no CORS, and same-site fetch checks.            | Another process running as the same OS user can still attack local files directly.   |
| Malicious Studio upload or path substitution                                               | Bounded streamed body to a server-selected opaque run, core re-sanitization, rejected-upload deletion, no browser-supplied filesystem paths.    | Safe but misleading visual/text content still requires human review.                 |
| Generated code executing in the Studio origin                                              | Escaped React text spans only; no `innerHTML`; preview runs on a separate ephemeral origin with script/network-denying CSP.                     | Browser/runtime defects remain dependency and patch-management risks.                |
| Concurrent Studio artifact corruption or overbroad deletion                                | One manifest per inspection/generation, opaque run IDs, exact real directory verification, single-run deletion and post-delete check.           | Local plaintext storage is not protected from an OS-level attacker.                  |
| Path traversal/symlink escape                                                              | Resolved target containment, exact file allowlist, realpath/lstat checks, artifact hash verification.                                           | OS compromise can bypass process-level controls.                                     |
| Arbitrary command execution                                                                | Executable plus exact argument arrays; `shell:false`; timeouts/output caps; no MCP shell tool.                                                  | An allowlisted executable may itself be vulnerable.                                  |
| Network/data exfiltration                                                                  | Isolated browser, service workers blocked, endpoint/path allowlist, external network blocked, output policy.                                    | Live Chrome MCP cannot enforce Playwright interception equivalently.                 |
| Cross-tenant/user/repository leakage                                                       | Explicit authenticated context placeholder, opaque namespaces, authorization provider, scope-first memory filtering, tests.                     | The included local stores remain single-process/local; deployment auth must be real. |
| Baseline laundering                                                                        | Human actor/reason/approval required; no auto-update.                                                                                           | Reviewer can intentionally approve a bad baseline.                                   |
| Audit tampering                                                                            | Append-only interface and hash-chain verification/export.                                                                                       | Local files are not immutable/WORM; ship and protect them externally.                |
| Secret/personal data persistence                                                           | Recursive redaction, URL sanitization, secret scan, output policy, evidence budgets.                                                            | Detection is defense in depth and not a full DLP system.                             |
| Backup disclosure/corruption                                                               | Optional AES-GCM with scope AAD, per-file hashes, non-overwriting restore.                                                                      | Key lifecycle/KMS and encrypted volume are deployment duties.                        |
| Retry/replay                                                                               | Channel event deduplication; deterministic patch/findings hashes; run IDs.                                                                      | In-memory dedup state needs a durable backend for multi-instance routing.            |
| Denial of service                                                                          | Evidence/file/context/pass/time limits and cancellation.                                                                                        | No remote rate limiter is shipped because remote MCP is disabled.                    |

Report security issues through the repository owner's private process. Do not put secrets or private
designs in public issues.
