# CLI and Studio Agent Handoff Plan

Status: Proposed — revised 2026-08-20

## 1. Goal

Provide the same bounded authoring and deterministic review workflow in CLI and Studio, with or
without MCP.

Studio has two work types:

| Work type                  | CLI                                   | Authored files                                             | Review target             |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------- | ------------------------- |
| Standalone generation      | `smart-ui generation prepare/review`  | Task-local `index.html`, `styles.css`, optional SVG assets | Isolated generated bundle |
| Existing UI implementation | `smart-ui validate-ui prepare/review` | Exact allowlisted React/Angular source files               | Declared running route    |

Each work type has two agent continuations:

1. **Connected MCP agent** — Studio displays a copyable MCP prompt; the agent reads and submits the
   task through bounded MCP tools.
2. **External agent or human** — Studio/CLI displays evidence paths, exact writable locations,
   `AGENT_INSTRUCTIONS.md`, and the exact CLI review command.

Both continuations use the same persistent task and converge on the same deterministic Studio Review
experience. Agent transport never changes scoring, evidence, policy, or acceptance.

## 2. Required boundaries

- CLI handoff never invokes a model, creates an MCP queue, or waits for an agent.
- Free-form JSX, TSX, JavaScript, TypeScript, HTML, CSS, JSON, Markdown, and text are bounded,
  redacted, untrusted UTF-8 evidence. They are never executed or treated as scoring truth.
- Pinned SVG/PNG and schema-validated structured context/presentation settings are authoritative
  evidence. Current literal user instructions outrank context and memory.
- Generation writes only its contained proposal directory.
- Validate-UI declares exact target-relative UTF-8 files. No globs, directory-wide writes, implicit
  path expansion, deletion, rename, binary authoring, dependency installation, or arbitrary shell.
- Smart UI enforces MCP writes. An external process cannot be OS-enforced by Smart UI; instructions
  declare its authorized scope and review snapshots only that scope. Unrelated dirty-worktree changes
  are not attributed to or rolled back by the task.
- Review validates but does not author or repair. It does not use `MockCodingProvider`, the heuristic
  provider, or a model.
- Failed implementation review preserves authored files. Acceptance changes task metadata only; it
  does not commit, push, deploy, publish, or rewrite repository files.
- The first validate-UI slice requires an already-running route. Later server startup may reference a
  named exact executable/argument configuration; raw command strings remain forbidden.
- Existing `smart-ui generate`, `validate`, `validate-matrix`, and `fix` behavior remains compatible.

## 3. CLI contract

### Standalone generation

```bash
smart-ui generation prepare \
  --workspace /absolute/workspace \
  --design /absolute/workspace/design.png \
  --design-context /absolute/workspace/Design.jsx \
  --structured-context /absolute/workspace/context.json \
  --presentation /absolute/workspace/presentation.json \
  --mode semantic \
  --layout responsive

smart-ui generation review \
  --task /absolute/workspace/.smart-ui/generation-tasks/task-<id>/task.json \
  --open
```

The proposal manifest is exactly:

- `index.html`
- `styles.css`
- optional `assets/<name>.svg`

Review snapshots the proposal, validates paths/bytes/UTF-8/HTML/CSS/URLs/active content, runs it
through `HostProposedHtmlGenerationProvider`, compares it with the deterministic fallback in isolated
Chromium, and persists a normal `GenerationRecord`, files, screenshots, diff, overlay, report, and
ZIP.

### Existing UI implementation

```bash
smart-ui validate-ui prepare \
  --target /absolute/application \
  --design /absolute/application/design.png \
  --design-context /absolute/application/Design.jsx \
  --structured-context /absolute/application/context.json \
  --presentation /absolute/application/presentation.json \
  --route http://127.0.0.1:4173/dashboard \
  --allow-write src/pages/Dashboard.tsx \
  --allow-write src/pages/Dashboard.css

smart-ui validate-ui review \
  --task /absolute/application/.smart-ui/validate-ui-tasks/task-<id>/task.json \
  --open
```

Prepare performs read-only React/Angular inspection and records applicable components, tokens,
conventions, routing, state patterns, tests, exact writable paths, existing/new-file baselines, route,
viewport/state matrix, and policy.

Review revalidates the task and declared files, creates an immutable before/after snapshot, inspects
the repository again, captures the declared running route in isolated Chromium, and persists ordered
viewport/state `RunRecord` evidence. It never executes supplied design context.

### Shared lifecycle commands

```bash
smart-ui task status --task /absolute/task.json --json
smart-ui task accept --task /absolute/task.json --attempt 1
smart-ui task cancel --task /absolute/task.json
```

- `prepare --dry-run` inspects and prints the proposed handoff but creates no task, queue, or retained
  artifact.
- `review` never accepts implicitly. Without `--open`, it exits after persistence and prints the
  exact Studio command. `--json` is headless and incompatible with `--open`.
- Human and versioned JSON output expose task ID/hash, state revision, paths, writable locations,
  attempt, record/report/archive references, findings summary, and exact next command.

## 4. Task and storage contract

Use a shared envelope with distinct `GenerationTask` and `ImplementationTask` bodies.

```text
.smart-ui/<generation-tasks|validate-ui-tasks>/task-<id>/
├── task.json                 # immutable authoritative contract
├── state.json                # atomic mutable lifecycle state
├── AGENT_INSTRUCTIONS.md     # derived advisory handoff
├── evidence/                 # copied/redacted/hash-verified evidence
├── proposal/                 # generation only; editable between attempts
├── repository/               # validate-UI inspection/baseline metadata
└── reviews/
    └── attempt-0001/
        ├── submission.json
        ├── submitted/
        ├── result.json
        └── artifacts/
```

### Immutable task fields

- schema version, task ID/type, creation time, canonical roots, and task hash;
- verified design media/dimensions/length/original hash and SVG sanitized hash when applicable;
- optional design-context original hash plus redacted artifact/hash and redaction status;
- structured context/hash, presentation spec/hash, literal instructions, rendering settings;
- normalized inspection summary, decisions, uncertainties, provenance;
- exact writable paths, review inputs/policy, and generated next/review commands;
- optional originating Studio run association.

`ImplementationTask` additionally stores framework inspection/hash, file baselines, route,
viewport/state matrix, endpoint policy, and relevant validation configuration snapshot/hash.

### Mutable state

`state.json` stores task hash, monotonic revision, status, active attempt, attempt references,
accepted attempt, and last verified Studio association.

```text
prepared -> awaiting-author -> reviewing -> awaiting-decision -> accepted
                                  |                 |
                                  +-> revision-needed <+
                                  +-> failed
```

Rejected/failed review returns to `revision-needed`; the next review creates a new attempt. Accepted
is terminal. Attempts and evidence are never overwritten.

### Integrity and concurrency

- All hashes use the existing `sha256:<hex>` byte representation.
- `task.json` and attempts are created by temporary-directory/file plus atomic rename.
- `state.json` updates compare the expected task hash and revision before atomic replacement.
- One process owns a task mutation through an atomic bounded operation marker. Competing CLI/Studio/
  MCP work fails with `TASK_BUSY`; it does not wait indefinitely.
- Recovery may clear only a verified stale marker and quarantines incomplete/malformed attempts.
- Studio polls verified `state.json` revisions only; it never infers completion from editable files.
- `AGENT_INSTRUCTIONS.md` clearly separates trusted policy from literal untrusted design/user text.
  Paths and commands come only from validated contract fields.

## 5. Evidence and scoring

- PNG intake verifies signature, byte budget, dimensions, and hash, then copies the pinned reference.
- SVG intake reuses the existing fail-closed sanitizer and structure provider. Only sanitized SVG is
  rendered or handed to agents.
- Validate-UI creates a normal `DesignContract`: PNG is the primary raster reference; SVG is rendered
  deterministically at the primary canvas while retaining structure/provenance.
- The primary canvas receives source-fidelity scoring. Additional viewports receive fidelity scores
  only when they have pinned references; otherwise they report robustness/runtime/accessibility
  findings with no invented visual similarity.
- Validate-UI persists a small `ImplementationReviewIndex` pointing to ordered viewport/state
  `RunRecord`s and classifying each cell as source fidelity, referenced fidelity, or robustness only.
- Task records contain bounded summaries and artifact references; large images, traces, snapshots,
  reports, and ZIPs remain content-addressed artifacts.

## 6. Studio and MCP

Studio remains one normal application with two top-level work types and a shared progression:

```text
Input -> Preferences/boundaries -> Handoff/work -> Review -> Accept/revise
```

For either work type, Handoff shows:

- **Continue with connected MCP agent** — copyable MCP instructions.
- **Continue with external agent or human** — exact evidence/instruction/write paths and CLI review
  command.

Studio always creates the persistent task first. MCP and external continuations reference that same
task and produce the same immutable attempt format.

Validate-UI is enabled only when Studio starts with an explicit `--target <absolute-repository>` or
imports an explicit verified `--review-task`; the browser cannot grant a new filesystem root. If no
target is configured, the option is disabled with the exact restart command.

Studio stores a bounded task association in its run pointer and imports task artifacts only through
verified manifests/opaque IDs. It retains current loopback binding, capability cookie, CSRF,
Host/Origin/method/media checks, no CORS, CSP-separated preview, retention, and deletion protections.
Deleting a CLI-imported run unregisters it but does not delete its task or repository files.

`review --open` imports/navigates to the selected attempt in normal Studio. A Studio-originated task
advances automatically when polling observes a verified reviewed state. A running Studio may be
reused through a non-secret loopback session descriptor; capabilities and CSRF values are never
written to disk.

Task-backed MCP tools must:

- list/get bounded pending tasks and paged evidence;
- submit approved generation files or exact validate-UI file contents for one task hash/revision;
- calculate manifests and scores server-side;
- enforce MCP-root, file, byte, command, route, endpoint, timeout, and cancellation policy;
- roll back an incomplete technical write transaction, but preserve a completely applied reviewed
  implementation attempt for revision.

Existing Studio generation MCP tool names remain compatibility adapters during migration. Direct
generation/validation MCP tools remain separate and do not implicitly create Studio tasks.

## 7. Implementation structure and order

Keep task logic in core; CLI, Studio, and MCP are thin adapters.

### Core responsibilities

- Task/state/attempt schemas and strict readers.
- Atomic task store, locking, recovery, hashing, containment, and lifecycle helpers.
- Deterministic instruction/JSON projection.
- Generation prepare/review service.
- Validate-UI prepare/review service and `ImplementationReviewIndex`.
- Shared bounded Studio Review projection over `GenerationRecord` and `RunRecord` evidence.

Move reusable PNG/context intake currently embedded in CLI into core. Do not duplicate path,
manifest, instruction, or scoring logic in adapters.

### Delivery order

1. Shared immutable task/state/attempt store plus `task status/accept/cancel`.
2. Generation prepare and dry-run.
3. Generation review, revisions, records, reports, and ZIP.
4. Studio generation handoff parity and task-backed MCP compatibility.
5. `ImplementationTask`, React/Angular inspection, raw SVG/PNG normalization, and validate-UI
   prepare.
6. Validate-UI route review, matrix index, immutable source attempts, and MCP submission.
7. Studio validate-UI work type, shared Review adapter, recovery, documentation, and packaging.

Suggested focused modules:

- core: `handoff-contracts`, `handoff-store`, `handoff-instructions`, `generation-handoff`,
  `implementation-handoff`, `implementation-review`, `task-review-view`;
- CLI: generation-task, validate-ui, and shared task lifecycle command modules;
- Studio: task registry/import/polling server adapter and shared review client adapter;
- MCP: task tools delegating to core services.

## 8. Migration

- Remove CLI queue/wait code, CLI `--agent-timeout`, and `smart-ui generate --engine agent`.
- `--engine agent` must return a migration message pointing to `smart-ui generation prepare`; it must
  not silently run deterministically.
- Keep Studio's explicit connected-agent flow, backed by tasks, and temporarily retain existing MCP
  tool names as compatibility adapters.
- Preserve completed PNG/context/redaction/provenance improvements and all historical CLI, Studio,
  validation, security, memory, packaging, and browser behavior.

## 9. Completion gates

Implementation is complete when:

1. SVG/PNG plus optional supported context can prepare either task without MCP.
2. Instructions identify every trusted input, exact writable location, prohibition, and next command.
3. CLI and MCP submissions create the same immutable attempt and deterministic review evidence.
4. Generation review emits a normal `GenerationRecord`, report, screenshots/diff/overlay, files, and
   ZIP; unsafe proposals fail closed with actionable revision guidance.
5. Validate-UI review emits ordered React/Angular route/state/viewport `RunRecord` evidence without
   scoring unreferenced viewports or executing context.
6. Revisions never overwrite attempts; acceptance is explicit and revision-checked.
7. Concurrent/tampered/symlinked/traversing/oversized/stale work fails closed and interrupted work
   recovers without exposing partial attempts.
8. Studio exposes both work types and both continuation methods, survives refresh/restart, and opens
   the same bounded Review/acceptance flow without requiring MCP for external handoff.
9. Failed implementation reviews preserve authored and unrelated work; CLI-imported deletion never
   deletes task or repository files.
10. Existing one-shot CLI, deterministic Studio generation, and direct MCP workflows remain green.
11. Focused contract/CLI/Studio/MCP/security tests cover both work types, both continuations, recovery,
    containment, redaction, exact writes, route isolation, evidence routing, and clean deletion.
12. After manual Studio verification, formatting, lint, typecheck, build, full unit/integration and
    real-browser suites, evaluation/security/privacy/package/publish/clean-consumer/SBOM gates pass.

Do not commit, push, publish, deploy, install host integrations, or open a pull request without
explicit user approval.
