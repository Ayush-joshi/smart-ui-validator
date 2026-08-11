# SVG generation improvements and validation Studio extension

Status: proposed

Date assessed: 2026-08-11

This plan evaluates the eight deferred improvements in
[`confirm-then-improve-plan.md`](./confirm-then-improve-plan.md). It extends the acceptance criteria
in [`implementation-plan.md`](./implementation-plan.md) and
[`svg-to-html-generation-plan.md`](./svg-to-html-generation-plan.md). Phase 4 adds a matching Studio
experience for the existing repository-validation workflow without replacing or changing its
validation, repair, scoring, or approval behavior.

## 1. Decisions

Scores are relative to the controlled local pilot; 5 is highest.

|   # | Improvement                              |       Impact       | Feasibility | Decision                                                                                                                                                             |
| --: | ---------------------------------------- | :----------------: | :---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Explicit design-canvas viewport strategy |         5          |      4      | **Implement.** It fixes a foundational ambiguity between source dimensions and intended presentation size.                                                           |
|   2 | First-class multi-viewport fidelity      |         5          |      3      | **Implement after #1.** Responsive behavior needs honest per-viewport evidence and acceptance.                                                                       |
|   3 | Durable multi-process authoring queue    | 3 now / 5 at scale |      3      | **Implement last.** It is required for reliable concurrent Studio processes and chats but is not the first fidelity bottleneck.                                      |
|   4 | Structured design context                |         5          |      4      | **Implement.** Exact copy, tokens, semantics, and interactions are stronger evidence than one free-text field.                                                       |
|   5 | Deterministic convergence advice         |         3          |      5      | **Implement.** It can improve accept/revise decisions without controlling them.                                                                                      |
|   6 | Host-neutral decision UX                 |         4          |      4      | **Implement.** Studio, MCP hosts, and automation should use one decision state machine.                                                                              |
|   7 | One-command agent/Studio bootstrap       |         5          |      5      | **Implement.** It removes common setup, containment, stale-build, and host-restart failures.                                                                         |
|   8 | Binary and multi-turn proposals          |         2          |      2      | **Defer binary.** Complete text-based multi-turn proposals already exist; binary support adds substantial security and byte-budget complexity without a proven need. |

### Selected scope

Implement items 1 through 7 in the first three phases. Phase 4 adds the validation Studio experience.
For item 8, record text multi-turn proposals as complete and keep binary proposals deferred until an
owned evaluation case demonstrates that HTML, CSS, and sanitized SVG assets are insufficient.

## 2. Design rules

### Separate source dimensions from presentation intent

Do not change the existing meaning of `SvgGenerationInput.viewport` or `DesignBundle.viewport`.
Add a versioned `PresentationSpec` containing:

- a primary target canvas with stable ID, width, height, and DPR;
- fit mode: `intrinsic`, `contain`, `cover`, or `stretch`;
- horizontal and vertical alignment;
- a bounded validation viewport matrix;
- required or advisory status for each viewport; and
- an optional contained reference for an exact viewport.

The source render, authoring guidance, generated capture, preview, diff, and overlay must use the
same canvas contract. With no `PresentationSpec`, behavior remains intrinsic and compatible with the
current default.

### Keep fidelity and robustness distinct

Every viewport has one evidence classification:

- `source-fidelity` for the primary matching source;
- `alternate-reference-fidelity` for a supplied matching viewport reference; or
- `responsive-robustness` when no matching reference exists.

Only matching-reference viewports receive similarity and mismatch scores. Robustness-only viewports
receive deterministic overflow, clipping, reading-order, focus-order, minimum-size, runtime, and
accessibility findings. A desktop reference must never be scored against a narrow screenshot.

Required viewports participate in overall acceptance. Advisory viewports can warn but cannot
silently pass or fail the run.

### Use typed, bounded design evidence

Add a versioned `StructuredDesignContext` shared by Studio, CLI, MCP, and authoring requests:

- exact copy: ID, label, text, locale, and optional source-node IDs;
- design tokens: name, kind, value, usage, and provenance;
- component semantics: ID, name, role, state or variant, and source-node IDs;
- interactions: trigger, target, resulting behavior or state, keyboard notes, and source-node IDs;
  and
- optional general notes for compatibility with the existing free-text input.

Enforce per-field, per-array, and total-character budgets. Treat all values as untrusted evidence,
retain provenance, and include a structured-context hash in each authored round.

### Use one host-neutral workflow coordinator

Move authoring and decision transitions behind a core `AuthoringWorkflowCoordinator` backed by an
`AuthoringWorkflowStore`. Studio HTTP, MCP, and headless CLI commands must call the same transition
functions.

The coordinator owns queueing, claims, submissions, evaluation, accept/improve/cancel decisions,
expiry, recovery, immutable round evidence, bounds, state versions, and idempotency. There must be
one authoritative decision record, not separate Studio and MCP decision files.

### Keep convergence advisory

Add a pure `analyzeRoundConvergence` function returning:

- `insufficient-evidence`;
- `improving`;
- `plateau`;
- `regressing`; or
- `mixed`.

It uses per-reference-viewport similarity deltas, required-viewport result changes, robustness
finding deltas, repeated hashes, and viewport regressions. It can explain whether another round may
be useful, but it must never accept, improve, cancel, select a round, or invent a score.

### Version strict schemas explicitly

The current Zod schemas are strict. Introduce new schema revisions rather than adding fields under a
literal `1.0` version.

- Readers accept supported old and new versions through discriminated unions.
- Writers emit the new version only after readers and migrations are present.
- Provide deterministic upgrades for safe persisted state.
- Fail ambiguous or unsupported state closed with recovery guidance.
- Preserve the meaning and readability of existing `1.0` records.

### Keep validation Studio as a thin host

The validation Studio experience must consume the existing `SmartUiOrchestrator`, `RunRecord`, MCP
tools, reports, artifacts, policies, and approval boundaries. It must not introduce a second
validation engine or reinterpret scores and findings.

Studio may display runs and collect bounded rerun feedback. It must not directly rerun validation,
apply repairs, approve writes, update baselines, or choose an agent action. An explicit user request
is handed to the connected agent, which continues to call the existing validation and repair tools.
Current instructions and feedback are untrusted evidence and cannot widen paths, commands,
endpoints, memory scope, or approvals.

## 3. Four-phase implementation plan

### Phase 1 — Authoring inputs, canvas contract, and setup

Goal: improve the evidence supplied to the agent, establish explicit presentation intent, and make
the workflow straightforward to start.

#### Work

1. Verify the current confirm-then-improve baseline and close existing fail-closed gaps before schema
   changes.
2. Add the new schema readers, migration functions, `StructuredDesignContext`, and
   `PresentationSpec`.
3. Add accessible Studio editors for exact copy, tokens, component semantics, and interactions.
   Retain the implementation note as general notes.
4. Add Studio controls for intrinsic or custom primary canvas, DPR, fit, alignment, and bounded named
   viewports. Persist exact values rather than device labels.
5. Carry structured context and canvas guidance through persisted preferences, authoring requests,
   revision rounds, compact MCP output, reports, CLI inputs, and MCP inputs.
6. Render the source reference, fallback, authored output, preview, diff, and overlay with the same
   primary-canvas rules.
7. Enforce viewport count, dimensions, DPR, total pixels, browser time, artifact bytes, and structured
   context budgets.
8. Add `smart-ui studio --agent` with:
   - `--host codex|claude|copilot`;
   - `--check-only`, `--json`, and `--dry-run`;
   - explicit `--ensure-engine` for dependency or Chromium installation;
   - MCP build freshness, Studio assets, Chromium, workspace, containment, and loopback checks; and
   - idempotent host-config creation without overwriting a differing existing file.
9. Extend `smart-ui doctor` with the same redacted setup checks.

#### Exit criteria

- Legacy free-text and intrinsic-canvas requests still work through compatibility readers.
- Typed context reaches the authoring request unchanged except documented validation and redaction.
- A small intrinsic component can be intentionally compared on a larger canvas without scale drift.
- `intrinsic`, `contain`, `cover`, and `stretch` are deterministic across source and output renders.
- Setup is idempotent and provides one exact recovery action for stale builds, invalid MCP roots,
  missing Chromium, unwritable workspaces, and differing host configurations.
- Invalid authored HTML, CSS, or SVG is rejected before it can create an ambiguous Studio result.

### Phase 2 — Multi-viewport evidence, convergence, and host-neutral decisions

Goal: validate responsive output honestly and expose the same review loop to Studio, MCP hosts, and
automation.

#### Work

1. Replace the single narrow capture branch with an ordered viewport-matrix evaluator shared by
   built-in and host-proposed generation.
2. Support optional contained SVG or image references for exact viewports, with normalization,
   hashes, and provenance.
3. Run fidelity comparison only at matching-reference viewports and expanded robustness checks at
   reference-free viewports.
4. Record each viewport's classification, threshold, required/advisory status, result, screenshot,
   reference, similarity or findings, and artifact hashes.
5. Aggregate required viewport results deterministically. Reject a proposal that improves one
   viewport but regresses another required viewport by default.
6. Update Studio, reports, compact MCP results, ZIP manifests, and evaluation scorecards with a
   consistent viewport result table.
7. Extract the existing lifecycle into `AuthoringWorkflowCoordinator` while preserving Studio route
   compatibility.
8. Add deterministic convergence advice after the second completed round and show its evidence
   without preselecting an action.
9. Add:
   - a read-only MCP tool for authoring and decision state;
   - an approval-gated, idempotent MCP tool for accept, improve, and cancel; and
   - a headless CLI flow that can enqueue, wait, report, stop at `awaiting-decision`, or apply a later
     exact decision.
10. Require exact run ID, expected state version, round when applicable, and idempotency key for
    decisions. Reject stale or conflicting actions.
11. Document equivalent Codex, Claude Code, Copilot, terminal, and automation flows without adding
    host-specific behavior to the core.

#### Exit criteria

- An owned fixture has desktop and narrow matching references with separate fidelity scores.
- Another fixture has a matching source viewport and reference-free narrow viewport that reports
  robustness only.
- A desktop improvement cannot hide a required mobile regression.
- Studio HTTP, MCP, and CLI decisions produce the same versioned transition record.
- Two conflicting decisions have one deterministic winner; the stale action fails with recovery
  guidance.
- No non-interactive flow waits forever or silently accepts a round.
- Convergence results are repeatable, explain their inputs, and cannot invoke a transition.

### Phase 3 — Durable local coordination and recovery

Goal: make the selected improvements reliable across cooperating local processes and restarts.

#### Work

1. Implement a versioned `AuthoringWorkflowStore` as a journaled local filesystem registry using:
   - per-run atomic locks;
   - monotonically increasing state versions;
   - atomic snapshots;
   - append-only bounded transition records;
   - opaque claim IDs and hashed lease tokens; and
   - lease owner, expiry, and heartbeat metadata.
2. Add explicit request claiming and renewal. Response submission requires the exact unexpired lease.
   Keep the existing list operation genuinely read-only.
3. Protect response submission and decisions with compare-and-swap checks against run, round, claim,
   and state version.
4. Resume waiting and response-received states after restart. Restart interrupted deterministic
   evaluation from the last safe boundary using the same response hash; never fabricate completion.
5. Make cancellation, expiry, lease reclamation, duplicate submission, and accepted-round selection
   idempotent.
6. Add retention and journal compaction without deleting immutable generation artifacts before their
   existing retention policy permits it.
7. Rerun bootstrap and clean-consumer checks against the final queue schema and MCP tool surface.

The bundled store supports cooperating processes on one local filesystem. NFS, remote workers,
multi-node failover, and a hosted transactional backend remain deployment-owned. Do not introduce
experimental Node SQLite or a native SQLite dependency for this phase.

#### Exit criteria

- Child-process contention tests prove that only one claimant owns a round at a time.
- A dead claimant's lease expires and another claimant can continue safely.
- Restart tests cover waiting, response received, evaluating, awaiting decision, accepted, canceled,
  and expired states.
- Duplicate submissions and decisions never duplicate rounds or overwrite accepted artifacts.
- Cross-workspace and symlink attempts fail closed.
- A packed clean consumer can bootstrap all documented hosts against the final tool surface.

### Phase 4 — Validation workflow experience in Studio

Goal: give repository validation the same clear run-review and feedback experience as SVG generation
while preserving the existing agent-led validation workflow.

#### Product experience

Add a top-level Studio workflow switch:

- **SVG generation** keeps the existing generation experience; and
- **Repository validation** displays validation runs and their existing evidence.

The validation area should provide:

- a filterable run list with status, target, component, viewport, start time, and stop reason;
- a run detail view with check score and visual similarity shown as separate metrics;
- target, implementation, diff, overlay, and report links from existing artifacts;
- findings grouped by viewport, category, and severity;
- pass history, changed files, rollback/regression state, runtime failures, accessibility findings,
  decisions, and provenance;
- comparison between two compatible runs without recalculating either score;
- bounded rerun feedback attached to the selected prior run; and
- a clear agent handoff state showing whether feedback is pending, acknowledged, running, completed,
  failed, canceled, or expired.

#### Rerun boundary

A rerun remains agent-led:

1. The user selects an existing run, enters optional feedback, and explicitly requests a rerun.
2. Studio creates a contained, immutable `ValidationRerunRequest` containing the prior run ID,
   reusable validated inputs, artifact references, feedback and its hash, creation/expiry times, and
   provenance. It contains no screenshot bytes, complete DOM dump, secrets, or new permissions.
3. Studio displays a copyable host-neutral prompt. It does not invoke validation itself.
4. The connected agent reads the request through a read-only MCP tool and acknowledges it through an
   idempotent coordination tool.
5. The agent calls the existing `validate_component` or approved `repair_component` workflow. All
   current path, command, endpoint, write, repair, and baseline approvals remain unchanged.
6. The resulting existing `RunRecord` links back to the rerun request and prior run. Studio then
   displays it as a new run; it does not merge or overwrite the earlier record.

Feedback is guidance for the next run, not authority to suppress findings, change thresholds, mask
regions, approve a baseline, edit code, or bypass deterministic evidence. A request mentioning
repair still requires the existing exact-file approval before `repair_component` can write.

#### Architecture and work

1. Add a read-only `ValidationRunCatalog` that discovers validated `RunRecord` files and their
   content-addressed artifacts inside the exact configured workspace. Do not depend only on the MCP
   server's process-local run map.
2. Add a Studio validation view model that projects existing records without changing their schema
   semantics. Unsupported record versions remain visible with bounded recovery guidance rather than
   being rewritten.
3. Add a versioned, bounded `ValidationRerunRequest` contract and store it through the Phase 3
   coordination primitives, with exact workspace containment, expiry, idempotency, and provenance.
4. Add MCP tools to list/get pending validation rerun requests and acknowledge/link their results.
   Tool annotations must reflect read versus mutation accurately. These tools coordinate work; they
   do not validate or repair.
5. Add Studio routes for validation run listing, detail, artifact retrieval, comparison, rerun
   request creation, cancellation, and status. Reuse existing Host/Origin/CSRF, session capability,
   retention, and download-manifest controls.
6. Reuse shared Studio components for run status, metrics, evidence, findings, history, feedback, and
   agent handoff while keeping generation and validation view models separate.
7. Add pagination and evidence budgets so Studio does not load every full record, DOM entry, or
   screenshot into one response.
8. Preserve actor, repository, project, component, viewport, prior run, rerun request, feedback hash,
   agent host, and resulting run provenance.
9. Update capabilities, tool counts, prompts, README, architecture, MCP, host, operations, security,
   and roadmap documentation.
10. Add final evaluation cases and run all quality, browser, security, privacy, packaging,
    clean-consumer, and reproducibility gates.

#### Explicit non-goals

- No Studio-owned validation or repair implementation.
- No automatic rerun after feedback is submitted.
- No automatic repair, baseline update, finding suppression, threshold change, or memory promotion.
- No change to `validate_component`, `repair_component`, `RunRecord`, comparator, repair stop
  conditions, or approval semantics unless a separate compatibility fix is required and reviewed.
- No direct target-repository writes from Studio.
- No requirement to keep the MCP server process alive for historical run viewing.

#### Exit criteria

- Studio lists and renders existing successful, failed, canceled, and repaired validation records
  without altering them.
- Scores, findings, pass history, and artifact hashes shown in Studio match the original record and
  offline report exactly.
- Submitting feedback creates only a rerun request; no browser capture, validation, repair, baseline,
  or target write occurs until an agent explicitly invokes the existing tools.
- A completed agent-led rerun creates a new immutable `RunRecord` linked to both the prior run and
  feedback request.
- Expired, duplicated, stale, canceled, cross-workspace, and symlinked requests fail closed.
- Existing CLI and MCP validation flows behave identically when Studio is unused.
- React and Angular validation, repair, rollback, memory, and baseline tests remain green.
- All required quality and release gates pass.

## 4. Binary proposal gate

Do not implement binary proposal submission in these four phases. Reconsider it only when all of
the following are true:

1. An owned, licensed fixture demonstrates a material result that cannot be represented with HTML,
   CSS, and sanitized SVG assets.
2. Required media types, decoding, metadata stripping, decompression limits, content scanning, CSP,
   export, and retention behavior are specified.
3. Bytes move through artifact handles or a bounded upload channel rather than inline MCP base64.
4. Per-file and aggregate decoded-byte and pixel budgets are enforced before rendering.
5. Privacy, secret, package, and clean-consumer checks cover the new artifact types.

Until then, accept only complete UTF-8 `index.html`, `styles.css`, and sanitized `assets/*.svg`
proposals. Continue using immutable complete-file rounds instead of ambiguous partial patches.

## 5. Verification

### Required new coverage

- Old/new contract migration and unsupported-version tests.
- Structured-context bounds, redaction, duplicate ID, provenance, injection, and round-trip tests.
- Canvas fit, alignment, DPR, transparent background, viewport matrix, and pixel-budget tests.
- Fidelity-versus-robustness classification and required/advisory aggregation tests.
- Cross-viewport proposal regression tests.
- Convergence histories for insufficient, improving, plateau, regressing, mixed, and repeated output.
- MCP annotations, stale versions, idempotency, claims, leases, and decisions through the official
  in-memory transport.
- Multi-process contention and crash/restart integration tests.
- Studio accessibility and UI tests for structured inputs, viewports, advice, stale decisions, and
  recovery.
- Validation Studio tests for run discovery, record projection, pagination, artifact access,
  comparison, feedback requests, agent handoff, and strict no-side-effect submission.
- Contract tests proving Studio displays the same validation scores, findings, passes, and hashes as
  the original `RunRecord` and report.
- Tests proving validation feedback alone cannot invoke a browser, run commands, modify a target,
  approve a repair, update a baseline, or promote memory.
- Real-Chromium custom-canvas, responsive-reference, robustness-only, multi-round, and recovery
  scenarios.
- Real-Chromium validation Studio scenarios covering run review, feedback handoff, and display of the
  resulting separately executed agent-led rerun.
- Packed clean-consumer setup tests for Codex, Claude Code, and Copilot.

### Required gates

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

Record exact test counts, owned fixtures, repeatability results, tool counts, package contents, and
live-versus-mocked integration status. Do not describe a configured host as live-verified unless it
was actually exercised.

## 6. Definition of complete

The selected improvements are complete when:

- users can supply typed design context and choose an explicit target canvas and bounded viewport
  matrix;
- every viewport reports honest fidelity or robustness evidence and required viewport policy drives
  acceptance;
- Studio, MCP, and CLI use one versioned, idempotent decision state machine;
- convergence advice is deterministic, explainable, and non-authoritative;
- cooperating local processes use claims and leases without duplicate rounds or lost decisions;
- `smart-ui studio --agent` verifies and starts the final workflow with precise recovery guidance;
- Studio provides validation run history, evidence review, comparison, and feedback handoff without
  owning or automatically triggering validation or repair;
- old records and intrinsic defaults remain supported through explicit migrations;
- all browser, evaluation, security, privacy, packaging, and clean-consumer gates pass; and
- binary proposals, remote coordination, and unverified live-host behavior remain accurately out of
  scope.
