# Deferred large improvements: assessment and implementation plan

Status: proposed

Date assessed: 2026-08-11

Source: the eight items under **Deferred large improvements** in
[`confirm-then-improve-plan.md`](./confirm-then-improve-plan.md).

This plan extends, and does not replace or reduce, the acceptance criteria in
[`implementation-plan.md`](./implementation-plan.md) and
[`svg-to-html-generation-plan.md`](./svg-to-html-generation-plan.md).

## 1. Current baseline

The repository is further along than the source list implies. The working tree already contains the
round-aware confirm-then-improve loop: immutable authored rounds, prior deterministic evidence,
Studio accept/improve decisions, and round-aware MCP request submission. Those changes are
uncommitted and the complete automated gate set has not yet been rerun. They are the baseline for
this plan, not work to implement again.

The important current constraints are:

- `DesignBundle.viewport` and Studio authoring guidance use the SVG's intrinsic or explicitly
  overridden source viewport.
- Generation evaluates source fidelity at one matching viewport and responsive robustness at one
  configured narrow width. A robustness-only viewport intentionally has no similarity score.
- Studio persists run pointers and immutable generation artifacts, but an active task becomes
  `interrupted` after a process restart. The authoring queue has atomic files and round high-water
  marks, but no claims, leases, or cross-process compare-and-swap state.
- Studio accepts one bounded free-text implementation note. It does not have typed copy, token,
  component-semantic, or interaction evidence.
- Studio owns the accept/improve HTTP endpoint. MCP can author a round but cannot read or submit the
  user's decision through a shared host-neutral decision boundary.
- `workflow:setup` prepares repository validation. It does not fully bootstrap and verify the
  Studio-plus-agent workflow.
- Authored proposals already support multiple complete text rounds and multiple UTF-8 files. They do
  not accept binary assets.

## 2. Decision summary

Scores are relative to the current controlled local pilot: 5 is highest.

|   # | Improvement                              |       Impact       | Feasibility | Decision                                            | Reason                                                                                                                                                                                                                                                                                   |
| --: | ---------------------------------------- | :----------------: | :---------: | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Explicit design-canvas viewport strategy |         5          |      4      | **Implement**                                       | It corrects a foundational ambiguity that affects authoring guidance, reference rendering, scoring, and responsive work. The current input already has a viewport override, but it does not separate intrinsic design dimensions from presentation intent.                               |
|   2 | First-class multi-viewport fidelity      |         5          |      3      | **Implement after #1**                              | Responsive behavior is a core product promise. The implementation must distinguish matching-reference fidelity from reference-free robustness at every viewport.                                                                                                                         |
|   3 | Durable multi-process authoring queue    | 3 now / 5 at scale |      3      | **Implement late**                                  | It is not the first fidelity bottleneck, but it is required for several chats or Studio processes to work reliably. Scope it to one local filesystem; remote and multi-node coordination remain deployment-owned.                                                                        |
|   4 | Structured design context                |         5          |      4      | **Implement**                                       | Exact copy, token values, semantics, and interaction intent are higher-quality and more reviewable evidence than one free-text field.                                                                                                                                                    |
|   5 | Deterministic round-convergence advice   |         3          |      5      | **Implement**                                       | It is inexpensive once round and viewport evidence are stable. It improves decisions without granting the engine authority to accept or continue automatically.                                                                                                                          |
|   6 | Host-neutral decision UX                 |         4          |      4      | **Implement**                                       | It removes the VS Code/paste-flow assumption and aligns Studio, Codex, Claude Code, and headless use with one core state machine.                                                                                                                                                        |
|   7 | One-command agent/Studio bootstrap       |         5          |      5      | **Implement**                                       | It removes a frequent operational failure mode: stale builds, an invalid MCP root, missing host config, and forgotten host restarts.                                                                                                                                                     |
|   8 | Binary and multi-turn proposals          |         2          |      2      | **Defer binary; close the text multi-turn portion** | Complete text multi-turn proposals are already implemented by authored rounds. Binary uploads would add base64/context pressure, media parsing, malware/content validation, CSP changes, packaging work, and a much larger byte-budget surface without a demonstrated owned-corpus need. |

### Selected scope

Implement items 1 through 7. For item 8, update the source plan to state that bounded text
multi-turn proposals are complete and binary proposals remain deferred. Reconsider binary support
only when an owned evaluation case cannot reach its accepted result using HTML, CSS, and sanitized
SVG assets.

## 3. Architectural decisions

### 3.1 Separate source dimensions from presentation intent

Do not change the meaning of the existing `SvgGenerationInput.viewport` or
`DesignBundle.viewport` fields in place. Existing records and callers treat them as the normalized
source viewport.

Add a versioned `PresentationSpec` with:

- one required primary target canvas when the new feature is used;
- width, height, device-pixel ratio, and a stable viewport ID;
- an explicit fit strategy: `intrinsic`, `contain`, `cover`, or `stretch`;
- horizontal and vertical alignment for non-stretch modes;
- a bounded validation viewport matrix;
- whether each viewport is required or advisory; and
- an optional contained reference for that exact viewport.

The source SVG is rendered onto the primary canvas with the same fit/alignment rules used to explain
the task to the authoring agent. This prevents the guidance, reference screenshot, generated capture,
and deterministic comparison from using different canvases.

Defaults preserve current behavior: the primary canvas equals the normalized source viewport,
`fit=intrinsic`, and the existing configured narrow viewport remains robustness-only.

### 3.2 Preserve evidence semantics at every viewport

Each viewport must be classified independently:

- `source-fidelity`: the primary target has a matching rendered source;
- `alternate-reference-fidelity`: a user supplied a separate matching reference for that viewport;
  or
- `responsive-robustness`: no matching reference exists, so only deterministic overflow, clipping,
  reading-order, focus-order, minimum-size, runtime, and accessibility checks are allowed.

Never compare a desktop reference raster to a narrow generated screenshot. Never synthesize a
fidelity percentage for a robustness-only viewport.

Per-viewport acceptance is explicit. A required matching-reference viewport must meet its fidelity
threshold; a required robustness viewport must have no blocking findings. Advisory viewports may
warn but cannot silently fail or pass the complete run.

### 3.3 Use typed, bounded design evidence

Add a versioned `StructuredDesignContext` shared by Studio, the queue contract, the headless CLI, and
MCP. It contains bounded arrays for:

- exact copy: stable local ID, label, text, locale, and optional source-node IDs;
- design tokens: name, token kind, value, optional usage, and provenance;
- component semantics: stable local ID, name, role, state/variant, and source-node IDs;
- interactions: trigger, target, resulting state or behavior, keyboard notes, and source-node IDs;
  and
- general notes, retaining the existing free-text field as an optional compatibility path.

All strings remain untrusted evidence. Apply per-field, per-array, and total-character budgets;
redact only secrets and sensitive headers, not valid user copy. Persist exact provenance and include
the structured context hash in every authored round.

### 3.4 Establish one host-neutral workflow coordinator

Extract the authoring and decision lifecycle from Studio HTTP handling into a core
`AuthoringWorkflowCoordinator` backed by an `AuthoringWorkflowStore`. Studio HTTP, MCP, and the
headless CLI become thin adapters over the same transitions.

The coordinator owns:

- inspect, queue, claim, submit response, evaluate, await decision, accept, improve, cancel, expire,
  recover, and terminal transitions;
- exact expected run version and round checks;
- immutable round evidence and the selected/accepted round;
- bounded round count and wall-clock time; and
- idempotency keys for decisions and submissions.

There must be only one decision record and transition function. The Studio endpoint and a future MCP
decision tool call that function; they do not maintain separate files or precedence rules.

### 3.5 Use a durable local registry with expiring leases

Keep the default deployment local and dependency-light. Implement the store as a versioned,
journaled filesystem registry under the contained Studio workspace, using:

- per-run locks acquired with atomic create semantics;
- monotonically increasing state versions;
- atomic temporary-write plus rename for snapshots;
- append-only bounded transition records for recovery and audit;
- claim IDs, opaque lease tokens, lease owners, expiry, and heartbeat timestamps; and
- response/decision compare-and-swap against exact run, round, claim, and state version.

Do not use the experimental Node SQLite API or add a native SQLite dependency merely for this phase.
The `AuthoringWorkflowStore` interface leaves room for a deployment-owned transactional backend.
Document that the bundled store supports cooperating processes on one local filesystem, not NFS,
remote workers, or multi-node failover.

### 3.6 Keep convergence advisory and deterministic

Add a pure `analyzeRoundConvergence` function. It consumes immutable round evidence and emits one of:

- `insufficient-evidence`;
- `improving`;
- `plateau`;
- `regressing`; or
- `mixed`.

Its evidence includes per-reference-viewport similarity deltas, required-viewport pass/fail changes,
robustness finding deltas, repeated response/output hashes, and whether a prior viewport regressed.
Thresholds are strict configuration values and are written into provenance.

The result is advice only. It may say why another round may or may not be useful, but it must never
submit a decision, choose a round, invent a score, or bypass the configured round bound.

### 3.7 Evolve schemas explicitly

The existing Zod objects are strict. Do not silently add fields while retaining a literal `1.0`
schema version.

- Add a new generation input/record revision for presentation specs, viewport acceptance, and
  convergence evidence.
- Add a new authoring request revision for structured context, target canvases, claims, and context
  hashes.
- Readers accept the supported old and new versions through an explicit discriminated union.
- Writers emit the new version after migration lands.
- Provide deterministic upgrade functions for persisted Studio run pointers and queued requests
  where safe. Unsupported or ambiguous state fails closed with recovery guidance.
- Preserve the meaning and readability of all existing `1.0` generation records.

## 4. Implementation phases

Each phase is independently reviewable. Do not begin a later phase while its required predecessor is
red.

### Phase 0 — Reconcile and verify the current baseline

Goal: establish trustworthy evidence for the already-present confirm-then-improve work.

Work:

1. Review the current working-tree changes without discarding or rewriting unrelated user work.
2. Reconcile the outdated status in `confirm-then-improve-plan.md` with the implemented state.
3. Close current fail-closed gaps before feature work, including malformed authored output being
   rejected at MCP submission time rather than producing an unscored Studio round.
4. Run the focused bridge, MCP, Studio server/UI, and SVG sanitizer tests.
5. Run the complete baseline gates listed in section 6.

Exit criteria:

- Two-round accept/improve behavior is covered by unit/integration tests and real Chromium.
- Invalid authored HTML/CSS/SVG never creates a response file or an ambiguous blank score.
- The working-tree baseline and its documentation agree.
- All baseline gates pass before schema evolution begins.

### Phase 1 — Typed design context and safe Studio authoring forms

Goal: improve agent evidence quality without changing scoring.

Work:

1. Add `StructuredDesignContext` schemas, budgets, hashes, provenance, and compatibility migration.
2. Add accessible Studio row editors for exact copy, tokens, component semantics, and interactions;
   keep the implementation-note field as general notes.
3. Carry typed context through persisted preferences, authoring requests, MCP compact responses,
   revision rounds, and reports.
4. Extend authoring guidance to prioritize exact copy and typed tokens over inferred SVG text or
   values while clearly marking conflicts.
5. Add safe JSON import/export of only the structured context object for repeatable tests and bulk
   entry. Import validates before changing the active form.

Exit criteria:

- A round receives typed context unchanged except documented redaction and bounded normalization.
- Invalid, oversized, duplicate-ID, or traversal-like source-node evidence fails closed.
- The report shows which typed fields influenced a round and their provenance.
- Legacy free-text-only Studio requests continue to work through the compatibility reader.

### Phase 2 — Explicit target canvas and viewport matrix contracts

Goal: make presentation intent explicit and use the same canvas everywhere.

Work:

1. Add `PresentationSpec` and its migration path without reinterpreting the existing source viewport.
2. Add Studio controls for intrinsic/custom primary canvas, DPR, fit, alignment, and bounded named
   viewports. Provide sensible presets, but persist exact numeric values rather than device names.
3. Add equivalent CLI and MCP inputs.
4. Render the source reference, exact fallback, authored output, preview, screenshots, diff, and
   overlay with the same primary canvas contract.
5. Put concise primary-canvas and viewport-matrix guidance in every authoring request and report.
6. Enforce viewport count, per-dimension, DPR, total-pixel, browser-time, and artifact-byte budgets.

Exit criteria:

- Current callers with no presentation spec produce byte/schema-compatible behavior where promised.
- A small intrinsic component can be intentionally compared on a larger canvas without scale drift.
- `intrinsic`, `contain`, `cover`, and `stretch` have deterministic tests, including alignment and
  transparent background behavior.
- A canvas mismatch between reference capture and generated capture is impossible by construction.

### Phase 3 — First-class multi-viewport validation and acceptance

Goal: evaluate agent output across a bounded responsive matrix with honest evidence.

Work:

1. Replace the one-off narrow capture branch with an ordered matrix evaluator shared by built-in and
   host-proposed generation.
2. Support optional contained alternate SVG/image references for exact viewports. Normalize and hash
   each reference with provenance.
3. Run matching-reference comparison only when a reference is available; otherwise run the expanded
   robustness checks.
4. Record per-viewport thresholds, required/advisory status, result, screenshot, findings, and
   reference artifact where applicable.
5. Define overall acceptance as the deterministic aggregation of required viewport results. Keep
   proposal non-regression checks per viewport so one desktop gain cannot hide a mobile regression.
6. Update Studio comparison UI, reports, compact MCP results, ZIP manifests, and evaluation
   scorecards with a viewport table.

Exit criteria:

- At least one owned fixture has desktop and narrow matching references with separately measured
  fidelity.
- At least one fixture has a source reference plus a reference-free narrow viewport and reports only
  robustness at narrow width.
- A proposal improving desktop but regressing a required narrow reference is rejected or clearly
  retained only under an explicit reviewed policy; the default is rejection.
- Repeated runs produce stable viewport ordering, classifications, findings, and hashes.

### Phase 4 — Convergence advice and host-neutral decision state

Goal: help users decide and expose the same decision model to every host.

Work:

1. Move lifecycle transitions behind `AuthoringWorkflowCoordinator` while keeping existing Studio
   routes compatible.
2. Add and persist deterministic convergence advice after the second completed round.
3. Display advice, its evidence, and any per-viewport regressions in Studio without preselecting an
   action.
4. Add a read-only MCP tool for authoring/run decision state and an approval-gated, idempotent MCP
   tool for accept/improve/cancel decisions.
5. Require exact `runId`, expected state version, action, selected round where applicable, and
   idempotency key. Reject stale or conflicting decisions.
6. Add a headless CLI flow that can inspect/enqueue/wait/report and either stop at
   `awaiting-decision`, accept the first result only when explicitly requested, or accept/improve via
   a later exact command.
7. Document equivalent Codex, Claude Code, Copilot, terminal, and automation flows. Host names affect
   setup copy only, never core state behavior.

Exit criteria:

- Studio HTTP, MCP, and CLI decisions produce the same versioned transition record.
- Two simultaneous conflicting decisions have one deterministic winner; the stale action fails with
  recovery guidance.
- No non-interactive flow waits forever or silently accepts a round.
- Convergence advice is stable, explains its inputs, and cannot invoke a transition.

### Phase 5 — Durable local multi-process queue and restart recovery

Goal: support several local Studio processes and chats without duplicate authorship or lost state.

Work:

1. Implement the journaled `AuthoringWorkflowStore` and migrate existing queue/run pointers.
2. Add explicit request claiming and lease renewal. Submission requires the exact unexpired lease
   token; store only a token hash in durable state.
3. Add an MCP claim tool or an atomic claim option on an accurately annotated mutating tool. Keep the
   existing read-only list operation genuinely read-only.
4. Resume `awaiting-agent`, `awaiting-agent-revision`, and response-received states after restart.
   Re-run an interrupted deterministic evaluation from its last safe boundary using the same
   response hash; never fabricate completion.
5. Make cancel, expiry, lease reclamation, duplicate response, and accepted-round selection
   idempotent and compare-and-swap protected.
6. Add retention/compaction for completed journals without deleting immutable generation artifacts
   before their existing retention policy permits it.

Exit criteria:

- Child-process contention tests prove that only one claimant owns a round at a time.
- A killed claimant's lease expires and another claimant can safely continue.
- Restart tests cover waiting, response-received, evaluating, awaiting-decision, accepted, canceled,
  and expired states.
- Duplicate submissions or decisions never create duplicate round records or overwrite accepted
  artifacts.
- Cross-workspace and symlink attempts fail closed.

### Phase 6 — One-command agent/Studio bootstrap

Goal: make the completed workflow easy to start and diagnose.

Work:

1. Add `smart-ui studio --agent` as the supported entrypoint and reuse shared setup helpers rather
   than spawning arbitrary shell strings.
2. Check Node/pnpm compatibility, built MCP freshness, bundled Studio assets, Chromium availability,
   workspace initialization, writability, `SMART_UI_MCP_ROOT` containment, queue schema support,
   and loopback health.
3. Support `--host codex|claude|copilot` and emit the exact contained host configuration for the
   final tool surface.
4. Create an absent workspace-local host config idempotently when explicitly requested. If a config
   already exists and differs, do not overwrite it; print a bounded merge patch and exact restart
   instruction.
5. Add `--check-only`, `--json`, and `--dry-run`. Keep dependency installation or Chromium download
   behind an explicit `--ensure-engine` action.
6. Print the exact Studio URL, workspace, MCP root, server entrypoint, host restart step, and a
   copyable first request. Never print secrets or capability tokens.
7. Extend `smart-ui doctor` with the same redacted checks so startup failures have one recovery path.

Exit criteria:

- A clean packed consumer can bootstrap Studio and produce a valid host config without repository
  source paths.
- Re-running setup is idempotent and never overwrites a differing user config.
- An invalid broad MCP root, stale build, missing Chromium, unwritable workspace, or stale host
  process produces one precise recovery action.
- Codex, Claude Code, and Copilot config/schema smoke tests discover the same final tools.

## 5. Deferred binary proposal gate

Do not implement binary proposal submission as part of phases 0-6. Open a new design phase only when
all of these are true:

1. An owned, licensed fixture demonstrates a material result that cannot be represented with HTML,
   CSS, and sanitized SVG assets.
2. The required media types, decode rules, metadata stripping, decompression limits, malware/content
   scanning responsibility, CSP behavior, and export behavior are specified.
3. Binary bytes can move through artifact handles or a bounded upload channel rather than inline MCP
   base64.
4. Per-file and aggregate decoded-byte/pixel budgets are enforced before browser rendering.
5. Package, privacy, secret, and retention checks cover the new artifact types.

Until then, continue allowing only complete UTF-8 `index.html`, `styles.css`, and sanitized
`assets/*.svg` proposals. Multi-turn behavior remains the immutable complete-file round model; do not
introduce ambiguous partial patches into one generation record.

## 6. Verification strategy

### Focused coverage added by this plan

- Contract migration tests for old and new generation, authoring, and persisted-run records.
- Property/boundary tests for viewport counts, pixels, DPR, fit, alignment, references, and budgets.
- Structured-context redaction, size, duplicate ID, injection, provenance, and round-trip tests.
- Per-viewport fidelity versus robustness classification and acceptance aggregation tests.
- Proposal regression tests where viewports improve and regress in different combinations.
- Convergence tests for insufficient, improving, plateau, regressing, mixed, repeated-output, and
  threshold-boundary histories.
- MCP annotation, stale-version, idempotency, claim, lease, and decision tests through the official
  in-memory transport.
- Multi-process contention and crash/restart integration tests.
- Studio UI tests for accessible context editors, viewport matrices, advice, stale decisions, and
  recovery.
- Real-Chromium scenarios for custom canvas scaling, alternate responsive references, robustness-only
  viewports, two-round decisions, and restart recovery.
- Packed clean-consumer bootstrap tests for all three documented hosts.

### Required gates before a phase is called complete

Run the focused tests during implementation, then all applicable repository gates:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:studio
pnpm test:mcp:stdio
pnpm test:e2e
pnpm evaluate
pnpm evaluate:svg
pnpm security:secrets
pnpm privacy:check
pnpm package:check
pnpm consumer:check
pnpm publish:check
pnpm sbom
```

Record exact test counts, owned fixtures, repeatability results, tool counts, package contents,
audit findings, and live-versus-mocked integration status. Do not describe configured Codex,
Claude Code, or Copilot examples as live-verified unless each host was actually exercised.

## 7. Rollout and compatibility

1. Ship schema readers and migrations before any writer emits new records.
2. Keep intrinsic single-source behavior as the default through the viewport phases.
3. Put structured context and custom viewport matrices behind explicit Studio/CLI inputs until the
   owned corpus and migrations pass.
4. Introduce MCP tools additively; update capabilities, prompts, docs, expected tool counts, and host
   smoke tests in the same change.
5. Enable durable claims only after old unclaimed requests are migrated or expire. Never let old and
   leased writers race on one queue.
6. Keep binary proposals disabled and remote/multi-node persistence unclaimed.
7. Update `README.md`, `docs/architecture.md`, `docs/mcp.md`, `docs/hosts.md`,
   `docs/svg-generation-contract.md`, `docs/operations.md`, `docs/security.md`, and the two roadmap
   documents as each behavior becomes real.

## 8. Definition of complete

The selected improvements are complete only when:

- users can explicitly choose the presentation canvas and bounded viewport matrix;
- every viewport reports honest fidelity or robustness evidence and required viewport policy drives
  acceptance;
- typed design evidence reaches the authoring agent with bounds, hashes, and provenance;
- Studio, MCP, and CLI use one idempotent decision state machine;
- convergence advice is deterministic, explainable, and non-authoritative;
- cooperating local processes use claims and leases without duplicate rounds or lost decisions;
- `smart-ui studio --agent` verifies and starts the complete workflow with precise recovery guidance;
- old records and the default intrinsic workflow remain supported through explicit migrations;
- all repository, browser, evaluation, security, privacy, packaging, and clean-consumer gates pass;
  and
- binary proposals, remote coordination, and any unverified live host behavior remain accurately
  documented as out of scope.
