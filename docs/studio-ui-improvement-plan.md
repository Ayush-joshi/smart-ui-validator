# Studio UI Improvement Plan

Status: Implemented — 2026-08-20

## 1. Goal

Make Studio begin with two clear work types and carry both through one consistent workflow:

1. **Generate UI** — create standalone HTML/CSS from SVG or PNG evidence.
2. **Validate UI** — implement or review exact allowlisted files in the configured React/Angular target.

This is a UI restructuring over the existing task, review, security, and persistence contracts. It must
not create a second backend workflow or weaken filesystem boundaries.

## 2. Shared flow

```text
Work type -> Inputs -> Preferences and boundaries -> Handoff -> Review
```

Both work types use the same shell, step navigation, page width, form controls, status language,
command blocks, action bar, and responsive behavior.

### Generate UI

- Upload or drop one SVG/PNG design reference.
- Upload a context file, or type/paste bounded design context.
- Edit structured context and presentation settings when needed.
- Choose connected MCP agent or external agent/human handoff.
- Review deterministic generation evidence and explicitly accept or revise.

### Validate UI

- Show the startup-configured target repository as read-only context.
- Upload or drop one SVG/PNG design reference.
- Upload a context file, or type/paste bounded context.
- Enter the already-running route.
- Add exact target-relative writable files.
- Configure viewport/state boundaries when needed.
- Choose connected MCP agent or external agent/human handoff.
- Review ordered fidelity/robustness evidence and explicitly accept or revise.

## 3. Screen structure

### 3.1 Work type

The first viewport shows two equal choices, not a generation form:

- **Generate UI** — standalone offline bundle.
- **Validate UI** — existing React/Angular implementation.

Each choice has a short scope statement and availability state. Validate UI is disabled when Studio
was not started with `--target`, with the exact restart command shown nearby.

Studio always opens on this screen. Persisted runs and imported task associations remain available
under **Recent work**, but Studio does not preselect or resume one on startup. **Reset workflow**
returns here and clears only the active client form/navigation state. **Clear local history** is a
separate confirmed action that deletes Studio-owned runs and unregisters task associations without
deleting target repository files or the associated task files.

### 3.2 Inputs

Use one shared input layout with work-type-specific fields:

- file dropzone for design evidence;
- context source mode: **Upload** or **Paste/type**;
- bounded multiline editor for pasted context;
- clear required/optional labels and byte/path constraints;
- selected-input summary before continuing.

The browser must never grant or widen a filesystem root. Validate-UI design uploads are bounded,
staged under a server-selected target-contained `.smart-ui/studio-uploads` path, copied into immutable
task evidence by the core, and removed from staging after task preparation. Routes, presentation
paths, and exact writable files remain target-relative and are revalidated by the server/core.

### 3.3 Preferences and boundaries

Generate UI shows mode, layout, canvas, structured context, and presentation options. Its design
context control uses the same **Upload** / **Paste or type** presentation as Inputs, shows the
currently persisted context, and explicitly saves replacements through the bounded context endpoint.

Validate UI shows route, exact writable files, viewport/state matrix, and the configured target. Do
not expose arbitrary commands, directory-wide writes, globs, dependency installation, or server
startup strings.

### 3.4 Handoff

Present two equal continuation methods:

- **Connected MCP agent** — copyable task-backed MCP instructions.
- **External agent or human** — evidence paths, exact writable locations, instructions file, and
  exact CLI review command.

Both methods reference the same persistent task and converge on the same Review screen.

### 3.5 Review

Use one shared review composition for generation and validate-UI tasks:

- task state, revision, and attempt selector;
- findings and blocking findings;
- visual evidence and report links;
- fidelity scores only where a pinned reference exists;
- explicit “Not scored” treatment for robustness-only cells;
- changed allowlisted files for validate UI;
- Accept, Revise, Cancel, and Remove from Studio actions.

Removing an imported task from Studio must not delete its task or repository files.

## 4. Component direction

Refactor the current large client incrementally around shared components:

- `StudioShell`
- `WorkTypePicker`
- `WorkflowSteps`
- `InputSourceField`
- `ContextInput` with upload/paste modes
- `BoundarySummary`
- `ContinuationChoice`
- `CommandBlock`
- `TaskStatus`
- `ReviewSummary`
- `EvidenceGrid`
- `DecisionBar`

Keep state and API calls in the existing Studio client initially. Extract hooks or a state machine only
if component extraction leaves duplicated transition logic.

## 5. Delivery order

1. Add the work-type model and first-screen picker without changing backend contracts.
2. Move existing generation inputs into the shared workflow shell.
3. Add upload/paste context input shared by both work types.
4. Move validate-UI preparation into its own Inputs and Boundaries screens.
5. Replace the current handoff task list with a dedicated Handoff screen.
6. Build the shared task Review adapter for both task types.
7. Unify loading, empty, error, disabled, interrupted, and completed states.
8. Finish responsive styling and keyboard/focus behavior.
9. Update Studio UI/server tests and perform manual desktop/mobile verification.

Each step should remain usable and keep existing API routes compatible.

## 6. Visual rules

- Preserve Studio’s established visual language, typography, and colors.
- Use one spacing scale and one panel treatment across both work types.
- Keep cards only for the two work choices and repeated task/attempt items.
- Do not nest cards or turn every section into a floating container.
- Use consistent field labels, help/error placement, button hierarchy, and command blocks.
- Keep primary actions in a stable bottom action area on long forms.
- Ensure long paths and commands wrap without resizing or overlapping controls.
- Maintain visible focus, semantic headings, labels, and keyboard navigation.

## 7. Acceptance criteria

- Studio opens on a two-option Generate UI / Validate UI screen.
- Selecting either option starts the same five-step workflow shell.
- Both work types upload or drop bounded SVG/PNG design references through the same control.
- Users can upload context or paste/type it for either work type.
- Generation retains deterministic and task-backed handoff behavior.
- Validate UI remains unavailable without an explicit startup target.
- Both continuation methods are visible before review.
- Both task types use one consistent Review experience.
- Refresh/restart opens on Work type without preselecting persisted work; Recent work provides
  explicit access to recovered runs and current verified task revisions.
- Reset workflow is non-destructive; clearing local history is separate, confirmed, and bounded to
  Studio-owned runs and task associations.
- Imported-task removal remains non-destructive.
- Desktop and mobile layouts have no clipped text, overlapping controls, or horizontal page overflow.
- Existing Studio security, CLI, MCP, task integrity, and evidence-scoring contracts remain unchanged.

## 8. Focused verification

- Client tests for work-type selection and step transitions.
- Generation input tests for upload and pasted context.
- Validate-UI tests for disabled target, bounded design upload and cleanup, route, exact writes, and
  path rejection.
- Handoff tests for both continuation methods and copied commands.
- Shared Review tests for generation, fidelity cells, robustness-only cells, revisions, and acceptance.
- Refresh/restart and non-destructive unregister server tests.
- Keyboard navigation and accessible-name checks.
- Manual desktop/mobile browser review after implementation.

## 9. Non-goals

- New task schemas, scoring algorithms, or authoring transports.
- Browser-selected repository roots.
- Arbitrary shell commands or automatic dev-server startup.
- Changes to CLI/MCP task semantics.
- Marketing or landing-page content.
