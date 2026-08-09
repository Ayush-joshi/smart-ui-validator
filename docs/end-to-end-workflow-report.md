# End-to-end workflow test report and improvement plan

Date: 2026-08-09

Scope: Codex desktop, Smart UI Validator MCP/CLI, Angular bdoom target, local SVG evidence, Playwright Chromium, and Agent Memory SQLite

## 1. Executive summary

The exercise successfully validated the complete local workflow:

1. Connect Smart UI Validator to Codex through stdio MCP.
2. Inspect an existing Angular repository.
3. Normalize a local SVG reference into a `DesignContract`.
4. Capture the running application at the design viewport.
5. Produce deterministic raster, runtime, and accessibility findings.
6. Change implementation CSS and verify that visual mismatch moves from `99.998%` to `28.445%`.
7. Enable governed Agent Memory, prove that a candidate is excluded before confirmation, confirm it, restart providers, recall it in a later validation, and explain its provenance.

The test also exposed workflow and product defects. The important implementation defects were corrected and retained in Smart UI Validator. All bdoom source changes, copied design evidence, generated reports, configuration, governed JSON, and Agent Memory SQLite data were removed after the test; the bdoom Git worktree was clean at handoff.

The largest avoidable token cost was returning full `RunRecord` data—including repeated component discovery and artifact evidence on every finding—when the agent only needed a score delta, a few findings, and artifact paths. MCP validation and repair now default to compact responses, with full records available explicitly through `responseDetail=full` or `get_run`.

The largest first-run friction was separately building the engine, relocating evidence, choosing
contract/artifact paths, inspecting the project, normalizing the design, and restating those values.
`pnpm workflow:setup` now creates one stable target manifest and agent runbook; the idempotent MCP
`prepare_workflow` call consumes it once and returns reusable validation arguments.

## 2. What was tested

### Target and evidence

- Target: existing bdoom Angular application.
- Component: `LoginComponent`.
- Browser URL: `http://127.0.0.1:4200/`.
- Reference: native `1920x1080` SVG.
- Reference semantics: raster/vector appearance only; no sidecar element contract.
- Browser: isolated Playwright Chromium.
- Memory identity: tenant `local`, user `ayushjoshi`, repository-scoped.

### Observed validation behavior

- The unrelated initial implementation produced `99.998%` visual mismatch.
- A controlled CSS-only adaptation produced `28.445%` visual mismatch.
- Visual similarity therefore improved to `71.555%`.
- The check score remained `0` because every configured check was binary and still failed:
  - console error;
  - failed unauthenticated request;
  - two accessible-name violations;
  - raster threshold violation.
- The unauthenticated `/api/auth/me` request returned `401`, which was expected by the application but not declared as an approved validation state.
- A raw image contract had no semantic elements, so it could not produce design-to-DOM geometry or typography correspondence without a sidecar specification.

### Observed memory behavior

- Before confirmation, recall excluded the candidate with `state-candidate`.
- After explicit confirmation, a fresh provider process reopened the record from Agent Memory SQLite.
- A later validation recorded the confirmed memory ID in its `memory-recall` decision.
- A subsequent fresh provider explained the record as confirmed, in scope, unexpired, identity-bound, and previously used.
- Removing the bdoom `.smart-ui` directory at cleanup removed both the governed JSON and SQLite memory stores, as requested.

## 3. Defects found and corrections retained

| Finding                                                                | Root cause                                                                             | Retained correction                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| MCP validation did not recall memory                                   | `executeRun` created no memory provider or context                                     | MCP now selects the configured local or Agent Memory backend and passes explicit identity/scope context to the orchestrator |
| MCP memory tools ignored Agent Memory                                  | Tools always constructed `LocalMemoryProvider`                                         | Tools now honor `memory.backend` and wrap governance with `AgentMemoryProvider`                                             |
| MCP could not propose or reject candidates                             | Lifecycle surface exposed only list/explain/confirm/forget                             | Added status, proposal, and rejection tools while preserving explicit confirmation                                          |
| `list_memories` failed MCP result validation                           | `structuredContent` was an array instead of an object                                  | Memory list returns `{ memories: [...] }`; generic results also wrap non-object values                                      |
| Cross-user SQLite opening failed                                       | Hydration attempted to import foreign-identity records into an identity-bound provider | Agent Memory hydration filters tenant/user identity before governance import                                                |
| Recalled usage disappeared after restart                               | `lastUsedAt` changed only in governed JSON                                             | Recall now mirrors updated records back to Agent Memory SQLite                                                              |
| CLI `validate` ignored enabled memory                                  | Memory identity flags existed only on repair/run commands                              | Added memory and identity options to `validate` and `validate-matrix`                                                       |
| Agent had to manually recreate normalized JSON                         | `normalize_design` returned a contract but did not persist it                          | Optional `contractPath` now writes the validated contract and returns compact paths/metadata                                |
| Validation failed with missing reference object                        | Validation used a nested artifact root different from normalization                    | MCP workflow guide states that normalization and validation must reuse the exact artifact root                              |
| Full MCP runs consumed unnecessary context                             | Validation returned the entire record and repeated evidence artifacts                  | Validation and repair now default to compact summaries; full output is opt-in                                               |
| Score obscured visual progress                                         | Score counts passed binary checks and gives raster no partial credit                   | Compact output separately exposes `checkScore`, `visualMismatchPercent`, and `visualSimilarityPercent`                      |
| Newly built MCP tools were not visible                                 | The host retained the already-running stdio process                                    | Recovery guide explicitly instructs rebuilding and restarting the MCP host                                                  |
| Angular fixture build crashed in native LMDB cache under Node 24/macOS | Angular compiler cache native module aborted while opening/closing its database        | The controlled Angular fixture disables its generated CLI cache for deterministic builds                                    |

## 4. Correct workflow after the retained improvements

1. Run `pnpm workflow:setup` once with the target, design, URL, component, and host. Use
   `--ensure-engine` on first installation or after engine source changes.
2. Merge the generated host snippet only when MCP is not already configured, then restart the host
   once.
3. Ask the agent to call `prepare_workflow` with `.smart-ui/workflow.json`. Reuse its returned paths
   and arguments for the session.
4. Start the target application only when the configured URL is not already reachable.
5. Call `plan_component` before source changes, then validate with the prepared compact arguments.
6. Without a generated manifest, read `smart-ui://workflow-guide`, keep evidence inside
   `SMART_UI_MCP_ROOT`, and call `normalize_design` with:
   - one explicit `artifactRoot`;
   - a `contractPath`;
   - an optional `specPath` when semantic correspondence is required.
7. Pass the same `artifactRoot` and returned `contractPath` to `validate_component`.
8. Use the default compact response to decide the next step:
   - check score;
   - visual mismatch/similarity;
   - counts by finding category;
   - at most five finding samples;
   - memory recall summary;
   - report, run record, screenshot, diff, and overlay paths.
9. Open the HTML report or call `get_run` only when the compact response is insufficient.
10. Request approval for exact writable files before repair.
11. Treat runtime-state configuration separately from memory. For example, authenticate an unauthenticated route or explicitly adjust validation policy rather than memorizing that a `401` should be ignored.
12. Propose only a compact, stable preference after accepted work. Keep it inactive until the user confirms its exact text and scope.

## 5. Token-consumption analysis

### Avoidable sources observed

- Full validation responses repeated the same four evidence artifacts on every finding.
- The complete framework component list appeared again inside every run decision.
- The normalized contract was echoed to the host and manually echoed back into a file.
- Full records were returned even when only visual mismatch and one next action were needed.
- Troubleshooting required repository searches because the MCP server supplied no targeted recovery map.
- Score semantics required source inspection to understand why large visual improvement still produced zero.

One captured full validation response exceeded four thousand output tokens before any agent explanation. Larger runs scale with the number of findings and discovered components.

### Improvements implemented now

- Compact run responses are the default.
- Full evidence requires `responseDetail=full` or `get_run`.
- Compact findings omit repeated evidence arrays and include artifact paths once.
- Normalization can persist the contract directly.
- A lazily read MCP workflow resource carries recovery knowledge without adding it to every tool response.
- Compact responses distinguish binary check score from proportional visual similarity.

### Additional reductions planned

- Add compact/filtered modes to `inspect_project`, including component-name query, count, and continuation token.
- Replace repeated component discovery decisions with a content-addressed repository-inspection artifact ID.
- Add paged findings and `get_findings(runId, category, cursor)` instead of requiring the complete RunRecord.
- Add stable typed recovery codes and one short `nextAction` to every recoverable failure.
- Add local output-size metrics to evaluation gates, with telemetry disabled by default.
- Cache unchanged repository inspection by repository hash and configuration hash.
- Return only changed finding IDs between repair passes unless full pass history is requested.

## 6. Information MCP should supply when an agent encounters a similar issue

The new `smart-ui://workflow-guide` resource covers these recovery cases:

- artifact object missing because normalization and validation stores differ;
- input outside MCP root or symlink containment failure;
- target server unavailable or duplicate listener;
- zero check score despite improving visual similarity;
- raw image lacking semantic evidence;
- expected unauthenticated request treated as runtime failure;
- confirmed memory not recalled because identity, scope, state, expiry, or budget differs;
- rebuilt MCP server not loaded until host restart.

The guide is intentionally a resource rather than text attached to every response. Agents fetch it only when needed.

## 7. Governed-memory policy learned from the exercise

Suitable long-term memory:

- confirmed repository or user implementation preferences;
- component and token mappings;
- stable constraints;
- compact proven fixes with evidence hashes;
- durable interaction preferences.

Keep as artifacts or configuration instead:

- screenshots, overlays, traces, DOM/CSS dumps, and base64;
- transient scores or individual validation failures;
- current design measurements already present in pinned evidence;
- expected HTTP statuses and test authentication setup;
- source code, secrets, credentials, or permission changes.

Every memory remains advisory. Explicit current instructions, pinned design evidence, and policy outrank it. Candidates never influence a run; confirmation, identity, scope, lifecycle, and recall budgets are mandatory.

## 8. Prioritized workflow-improvement plan

### P0 — Completed in this exercise

- Wire Agent Memory into MCP validation and lifecycle tools.
- Fix structured memory results, identity hydration, and usage persistence.
- Enable memory on CLI validation commands.
- Persist normalized contracts through MCP.
- Add compact-by-default MCP run responses.
- Add lazy workflow and recovery guidance.
- Expose visual similarity independently from binary check score.
- Add an idempotent one-command target setup and generated target-specific agent runbook.
- Add `prepare_workflow` to combine manifest validation, project inspection, normalization, and
  reusable compact validation arguments.

### P1 — Next release

- Add typed recovery codes and compact failure envelopes.
- Add expected runtime-state configuration for approved status codes/endpoints without globally disabling network checks.
- Add filtered and cacheable project inspection.
- Add finding pagination and delta responses between repair passes.
- Fix duplicate finding IDs when identical rules affect different DOM elements.
- Add a readiness tool that reports target URL reachability, listener ownership, browser availability, artifact-root consistency, MCP build/version, and memory backend status.
- Add explicit score labels in HTML: check score, visual similarity, threshold status, and blocking-gate status.

### P2 — Controlled-pilot hardening

- Add an MCP run registry so hosts can continue with a short `runId` instead of absolute artifact paths.
- Add response character/token budgets enforced by schemas and evaluation gates.
- Add repository-inspection and normalized-design handles with content hashes and expiry.
- Add baseline visual-regression workflows separated from one-off design validation.
- Add local-only workflow metrics for number of tool calls, response characters, repair passes, and recovery attempts.
- Add restart/version negotiation so the host can detect stale MCP processes without user guesswork.

## 9. Acceptance criteria for the workflow improvements

1. A normal inspect-normalize-validate cycle completes without manually copying contract JSON.
2. Validation reuses the normalization store or fails with a typed, actionable artifact-root error.
3. Default validation output remains below 1,500 estimated tokens for up to 100 findings.
4. No evidence artifact is repeated per finding in compact mode.
5. Full records remain accessible through explicit opt-in paths.
6. Visual progress is visible even while binary validation gates fail.
7. An expected unauthenticated state can be configured narrowly without disabling unrelated failures.
8. Candidate memory is excluded, confirmed memory survives restart, cross-identity access returns no records, usage provenance survives restart, and forgetting removes JSON and SQLite records.
9. A stale MCP build is detectable through version/readiness metadata.
10. Formatting, lint, typecheck, production build, unit/integration tests, and real-browser React/Angular E2E gates remain green.

## 10. Cleanup and retained state

Removed from bdoom:

- login CSS experiment;
- `apps/web/smart-ui.config.json`;
- copied SVG design directory;
- `.smart-ui` design contracts, screenshots, diffs, overlays, reports, RunRecords, governed memory JSON, and Agent Memory SQLite database;
- temporary `.smart-ui/` Git-ignore entry.

Retained only in Smart UI Validator:

- MCP/CLI Agent Memory corrections;
- identity isolation and recall-usage persistence;
- compact workflow changes;
- workflow guidance;
- regression tests;
- deterministic Angular fixture cache configuration;
- this report and the authoritative roadmap entry.

## 11. Verification evidence

The final retained changes, including compact MCP responses, workflow guidance, memory corrections,
and documentation, passed:

- Prettier formatting;
- ESLint;
- TypeScript typecheck;
- production build;
- 81 unit/integration tests;
- three real-browser React/Angular E2E scenarios.

The bdoom worktree was also rechecked after verification and remained clean with no source diff or
generated Smart UI state.
