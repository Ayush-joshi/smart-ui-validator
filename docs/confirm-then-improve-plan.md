# Plan: confirm-then-improve loop for agent-powered Studio generation

Status: planned, not implemented. This document is the authoritative plan for the interactive
refinement loop on top of the agent-powered Studio generation flow shipped in this repository. It
also collects the larger improvements surfaced while building that flow (see
[Deferred large improvements](#deferred-large-improvements)).

Read [`docs/mcp.md`](./mcp.md), [`docs/handover-studio-mcp-agent.md`](./handover-studio-mcp-agent.md),
and the `AGENTS.md` working rules before implementing.

## Goal

After an agent-authored Studio run completes and the deterministic evidence is shown, the flow asks
the user whether to improve the design. If the user says yes (optionally with specific feedback), the
connected MCP chat agent authors a revised `index.html`/`styles.css`, Studio re-renders and re-measures
it through the same deterministic pipeline, and the result is presented again. This repeats until the
user is satisfied, cancels, or a configurable bound is reached. Every revision keeps immutable
provenance and honest comparison evidence.

### Principles (consistent with the product principles in `AGENTS.md`)

- Current user instructions and pinned design evidence outrank memory.
- Deterministic code calculates differences; the model authors and diagnoses but never scores.
- Refinement is bounded by round count, write scope, and reviewable evidence.
- All authored content is untrusted and passes unchanged through host-proposal validation.
- Provenance is retained for every revision (which agent, which feedback, which round).

## Current baseline this builds on

- File-queue bridge in [`packages/core/src/studio-agent-bridge.ts`](../packages/core/src/studio-agent-bridge.ts):
  `requests/<runId>.json` and `responses/<runId>.json`, Zod-validated, atomic writes, fail-closed
  expiry.
- MCP tools `list_studio_authoring_requests` and `submit_studio_authored_html`.
- Studio `awaiting-agent` phase; `HostProposedHtmlGenerationProvider` + deterministic
  `fallbackGenerator` with `proposalPolicy: 'prefer-proposal'`.
- Per-request `authoringCanvasGuidance` anchoring output to the design's exact render/compare canvas.

## Proposed design

### 1. Round-aware queue contract

Extend the bridge to support multiple rounds per run without breaking the single-file-per-run
invariant:

- Requests become `requests/<runId>/round-<n>.json`; responses `responses/<runId>/round-<n>.json`.
  Keep atomic temp-write + rename and single-writer-per-file.
- Add to the request schema: `round` (1-based int), `previousResponseHash` (optional), and a bounded
  `feedback` string (user's improvement instructions for this round, ≤ 4 000 chars, treated as
  untrusted, redacted the same way as `instructions`).
- Add to the request schema a compact `priorEvidence` block for round > 1: previous
  `visualSimilarityPercent`, mismatch percent, and the top findings (bounded, no raster bytes), so
  the agent can target the deltas. Evidence is derived by Studio from the deterministic record, not
  invented.
- Response schema unchanged except it also carries `round`.
- Validate `round` monotonicity and reject stale/duplicate rounds fail-closed.

### 2. Studio run lifecycle

Add phases to the `StudioRun` union and client labels:

- `awaiting-agent` (round 1) → `generating` → `completed`.
- New `awaiting-decision`: run completed a round and is asking the user to accept or improve.
- New `awaiting-agent-revision`: a revise request is queued for round n > 1.

State transitions:

1. Round 1 completes exactly as today, but instead of terminal `completed`, enter
   `awaiting-decision` (unless the user pre-selected "accept first result").
2. Studio surfaces accept / improve. Accept → terminal `completed` with the current round retained.
   Improve (with optional feedback) → write `round-<n+1>` request, enter `awaiting-agent-revision`,
   show the paste prompt again.
3. Agent submits round n+1; Studio renders/measures and returns to `awaiting-decision`.
4. Bound: stop after `maxImproveRounds` (config, suggest 5) with a clear terminal message; the user
   can still accept the best round.

Each round is an immutable record; retain all round records and mark which round the user accepted.
The accepted round's files are what the ZIP/report/export reflect.

### 3. Decision transport (no chat push)

MCP is agent→server pull, so the user's accept/improve decision is entered in Studio (HTTP), not the
chat. The agent only authors. Concretely:

- Studio adds `POST /api/runs/:runId/decision` with `{ action: 'accept' | 'improve', feedback? }`,
  same CSRF/same-site/host/origin checks as existing endpoints.
- On `improve`, Studio writes the next-round request and the client shows the paste prompt.
- The MCP tools gain round awareness: `list_studio_authoring_requests` returns the pending round and
  its `feedback`/`priorEvidence`; `submit_studio_authored_html` targets the exact `runId` + `round`.

### 4. Optional conversational confirmation

The user asked that the chat itself confirm before improving. Because the chat cannot be pushed to,
model this as an agent convenience, not a control path:

- Add a read-only MCP tool `get_studio_run_decision_state` (or extend
  `list_studio_authoring_requests`) so the agent can report the current evidence and ask the user in
  chat: "similarity is X%; author another round?" The authoritative accept/improve still flows
  through Studio's decision endpoint (or a new `submit_studio_decision` MCP tool that writes the same
  decision file under approval). Decide one path during implementation; do not create two sources of
  truth.

### 5. Studio UI

- Review step gains **Accept** and **Improve** actions and an optional feedback textbox.
- A round selector shows each round's similarity/mismatch and lets the user compare and accept any
  prior round.
- `awaiting-agent-revision` shows the same copyable prompt, annotated with the round number and the
  feedback that was sent.

### 6. Safety and provenance

- Reuse `HostProposedHtmlGenerationProvider` validation unchanged for every round.
- Cancel deletes the pending round request; expiry fails closed and offers the deterministic engine
  or accepting the best round.
- Record per round: authoring agent label, round number, feedback hash, response hash, and the
  deterministic comparison. Never store raster bytes in records.
- Bound total rounds, per-round timeout, and total wall-clock.

## Testing (add before running gates)

- Bridge: round request/response write/read, monotonic round validation, stale/duplicate rejection,
  expiry, malformed payloads — all fail-closed.
- MCP tools: round-aware `list_studio_authoring_requests` and `submit_studio_authored_html` via the
  in-memory transport pattern in [`tests/mcp-server.test.ts`](../tests/mcp-server.test.ts).
- Studio server: `awaiting-decision` → improve → `awaiting-agent-revision` → accept lifecycle, the
  decision endpoint's CSRF/host checks, cancel, timeout, and accepting a non-final round in
  [`tests/studio-server.test.ts`](../tests/studio-server.test.ts).
- Real-Chromium: a two-round improve scenario that keeps distinct immutable round records.

## Rollout

Additive and behind the existing engine choice. Default behavior can remain single-round until the
loop is verified; a preference (or config flag) opts into the confirm-then-improve loop. Update
`docs/mcp.md`, `docs/hosts.md`, the README Studio section, and `scripts/check-mcp-stdio.mjs` tool
counts if new tools are added.

## Deferred large improvements

Larger items surfaced while building the agent-powered Studio flow and the scale fix. They are out of
scope for the immediate workflow cleanup and should be scheduled deliberately.

1. **Design-canvas viewport strategy beyond intrinsic SVG size.** Today the render/compare viewport is
   the SVG's intrinsic viewport, and the agent is told to match it via `canvasGuidance`. For designs
   whose intended presentation differs from the SVG's intrinsic box (e.g. a component exported small
   but meant to render large, or responsive breakpoints), add an explicit, user-controllable target
   viewport (and optional breakpoint matrix) that drives both authoring guidance and deterministic
   capture. Requires contract, Studio preferences, and evidence changes.

2. **Multi-viewport / responsive fidelity for authored HTML.** Extend the responsive-robustness
   evidence to a first-class multi-breakpoint comparison for agent output, not only the narrow-width
   robustness check, with per-breakpoint acceptance.

3. **Durable, multi-process authoring queue.** The current file queue is single-writer and local. A
   robust multi-agent or multi-process setup (several Studio runs, several chats) needs a durable
   registry with leases and cross-process coordination, plus tests for contention.

4. **Structured design context beyond free-text.** Replace/augment the free-text context box with
   structured fields (exact copy, tokens, component semantics, interaction notes) that map into the
   authoring request as typed evidence, improving fidelity and reviewability.

5. **Automated round convergence heuristics.** Optional deterministic guidance that suggests whether
   another round is likely to help (e.g. diminishing similarity gains) to inform the user's
   accept/improve decision — advisory only; it must never auto-accept or score.

6. **Host-neutral decision UX for non-VS-Code hosts.** The paste-prompt + Studio-decision flow assumes
   a human relays between chat and Studio. Define equivalent flows for Codex and Claude Code, and a
   headless/automation mode, keeping the queue contract host-neutral.

7. **Setup ergonomics: one-command agent-Studio bootstrap.** A guided `smart-ui studio --agent`
   (or an extension of `scripts/setup-workflow.mjs`) that verifies the built MCP server, ensures
   `.vscode/mcp.json`, checks `SMART_UI_MCP_ROOT` containment, and prints the exact restart step —
   reducing the manual "rebuild → restart MCP server" round trips observed during development.

8. **Binary and multi-turn host proposals.** Allow non-text assets and multi-file/multi-turn proposals
   within one run, with corresponding validation and byte budgets.
