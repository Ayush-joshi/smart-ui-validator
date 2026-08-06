# Smart UI Validator

Smart UI Validator is a host-neutral TypeScript engine, CLI, and stdio MCP server for implementing
and validating UI work against pinned design evidence. It inspects React and Angular repositories,
normalizes local images or recorded/live Figma MCP evidence, captures isolated Chromium evidence,
calculates deterministic structural and raster findings, applies bounded policy-controlled repairs,
produces offline reports, and optionally recalls governed preferences.

Version 0.4.0 implements the four planned phases and is intended for a controlled internal pilot.
It does not claim a compliance certification, unattended production operation, or broad autonomous
code generation. The built-in repair provider still performs one deliberately narrow CSS
background-color repair; production hosts can supply a richer `RepairProvider` while the core keeps
all path, command, endpoint, pass, regression, and rollback limits authoritative.

## What is included

- React discovery for Vite, Next.js, Create React App, and Rsbuild layouts.
- Angular discovery that preserves standalone/NgModule, template, style, signal/observable, routing,
  test, and design-system conventions.
- Existing component, Storybook story, CSS/SCSS/TypeScript design-token, state-management, and route
  discovery. Every run records a reuse decision and ambiguity evidence.
- Local image/SVG and Figma MCP normalization into strict versioned `DesignContract` data.
- Desktop, tablet, and mobile viewport matrices plus declared default, hover, focus, active,
  disabled, loading, empty, and error states.
- Isolated Playwright Chromium capture with fixed time, locale, timezone, theme, reduced motion,
  animation suppression, evidence limits, endpoint allowlists, and external networking blocked by
  default.
- Geometry, typography, appearance, asset, raster, runtime, keyboard/focus, accessible name/state,
  duplicate ID, image alt, document language, and color-contrast findings.
- Explicit dynamic-region masking and human-approved visual-regression baselines. Baselines never
  auto-update.
- Bounded repair convergence, repeated finding/patch detection, minimum improvement, repository
  regression commands, rollback of modified and newly created files, timeout, and cancellation.
- Content-addressed screenshots, target images, diffs, overlays, JSON records, and offline HTML
  reports.
- Governed local or Agent Memory-backed preferences with identity/scope filtering, consent,
  lifecycle, budgets, correction, export, and verified forgetting.
- A stable MCP stdio server with tools, resources, prompts, JSON schemas, read/write annotations,
  compact structured output, run identifiers, cancellation signals, and explicit write approval.
- Tenant/user/repository/project namespaces, deny-by-default authorization interface, injected
  AES-256-GCM encryption provider, tamper-evident audit log, retention/legal-hold extension, and
  hash-verified non-overwriting backup/restore.
- Optional OpenClaw/Slack scope, approval, idempotency, redaction, and output-policy adapter. It is
  disabled by default and performs no network posting itself.
- CI, package-content checks, local secret scanning, dependency audit, local SBOM inventory,
  versioned evaluation corpus, and enforced release thresholds.

## Requirements

- Node.js 22.16 or newer.
- pnpm 10.15.0.
- Playwright Chromium. The install command below downloads the browser once.
- macOS, Linux, or Windows/WSL supported by Node and Playwright. VS Code MCP sandboxing is currently
  host/platform dependent; consult the current VS Code documentation.

Agent Memory uses Node's SQLite API, which Node currently marks experimental. The local JSON memory
store does not require SQLite.

## Install and build

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm smart-ui --help
pnpm smart-ui doctor --target . --json
```

Expected `doctor` output contains Node, framework, configuration, and Chromium checks. It is
read-only and redacts sensitive values. `ready: true` means local prerequisites were discovered; it
does not test external Figma, Chrome MCP, model, Slack, or remote authentication.

## First end-to-end validation

Normalize the checked-in React reference into a contract and content-addressed target artifact:

```bash
pnpm smart-ui design normalize \
  --image fixtures/react-app/design/reference.svg \
  --spec fixtures/react-app/design/intentional-spec.json \
  --out /tmp/smart-ui-design.json \
  --artifacts /tmp/smart-ui-artifacts \
  --json
```

In another terminal, start the fixture:

```bash
pnpm fixture:dev --port 4173
```

Validate without modifying source:

```bash
pnpm smart-ui validate \
  --target fixtures/react-app \
  --design /tmp/smart-ui-design.json \
  --route http://127.0.0.1:4173 \
  --artifacts /tmp/smart-ui-artifacts \
  --out /tmp/smart-ui-run.json \
  --json
```

What to expect:

1. The target is inspected without mutation.
2. The route is checked against the exact endpoint policy.
3. Chromium starts in an isolated context and external requests are blocked unless allowlisted.
4. DOM, computed style, accessibility, console, network, and screenshot evidence is bounded and
   captured.
5. Deterministic findings and a 0–100 score are created. The model does not invent the score.
6. Target, implementation, diff, overlay, content-addressed run JSON, and offline HTML report
   artifacts are written. The same RunRecord is written to `/tmp/smart-ui-run.json` without
   overwriting an existing file.
7. Validation exits `0` with no error findings, `3` with remaining error findings, or `4` when the
   run itself fails.

The fixture deliberately contains mismatches, so a validation exit code of `3` is expected.

Render the generated RunRecord as another offline report (the validation result already includes the
first report reference):

```bash
pnpm smart-ui report /tmp/smart-ui-run.json \
  --artifacts /tmp/smart-ui-artifacts \
  --format html \
  --json
```

## React and Angular repository inspection

```bash
pnpm smart-ui inspect --target /absolute/path/to/react-project --json
pnpm smart-ui inspect --target fixtures/angular-app --json
```

Inspection reports framework/build system, package manager, styling, tests, routes, state management,
Storybook, component locations/candidates, token definitions, native conventions, and ambiguities.
Discovery skips dependency/build/cache directories, caps files and bytes, and never writes to the
target. Mixed Angular standalone/NgModule conventions are surfaced so a host can preserve the nearest
component convention instead of applying a global preference.

Start the representative Angular fixture with:

```bash
pnpm fixture:angular:dev -- --host 127.0.0.1 --port 4273
```

Normalize `fixtures/angular-app/design/reference.svg` with its `spec.json`, then validate against
`http://127.0.0.1:4273`. The fixture demonstrates standalone components, signals, native control
bindings, responsive CSS, and loading/empty/error/disabled states via `?state=<name>`.

## Viewports, states, accessibility, and dynamic regions

One validation may override a state:

```bash
pnpm smart-ui validate \
  --target fixtures/angular-app \
  --design /tmp/angular-design.json \
  --route http://127.0.0.1:4273 \
  --state focus \
  --selector '[data-validation-id="angular-action"]' \
  --json
```

`hover`, `focus`, and `active` require a selector. `disabled`, `loading`, `empty`, and `error` assume
the supplied route already renders that state; set a state-specific `url` in configuration when using
the matrix command.

`validate-matrix` runs every configured viewport/state sequentially so browser processes and
artifacts remain bounded:

```bash
pnpm smart-ui validate-matrix \
  --target /absolute/path/to/project \
  --design /absolute/path/to/design-contract.json \
  --route http://127.0.0.1:4173 \
  --json
```

Elements that change nondeterministically must carry `data-smart-ui-dynamic` and match an explicit
`dynamicRegions[].selector`. An unapproved dynamic element fails closed. Approved region rectangles
are excluded from the raster denominator and remain visible in policy/config review.

Selected accessibility checks are deterministic and intentionally do not replace a full WCAG audit,
manual assistive-technology testing, or legal review.

## Bounded repair

Dry-run first:

```bash
pnpm smart-ui fix \
  --target fixtures/react-app \
  --design /tmp/smart-ui-design.json \
  --route http://127.0.0.1:4173 \
  --artifacts /tmp/smart-ui-artifacts \
  --allow-write src/styles.css \
  --max-passes 3 \
  --dry-run \
  --json
```

Remove `--dry-run` only after reviewing the exact proposed file. A write must be both inside the target
root and exactly listed by configuration or `--allow-write`; a parent directory is not a recursive
grant. Configured format/typecheck/test commands must match executable and argument arrays exactly.
Shell strings are never evaluated. A regressing or non-improving patch is reverted; run history keeps
the attempted patch hash, rationale, findings, score, timing, failure, and terminal reason.

`run` is a backward-compatible alias for `fix`. The bundled heuristic provider is not a general
React/Angular implementation model; integrate a reviewed `RepairProvider` for broader production use.

## Reports and direct image comparison

```bash
pnpm smart-ui report /absolute/path/to/run-record.json \
  --artifacts /absolute/path/to/artifacts \
  --format html

pnpm smart-ui compare target.png implementation.png \
  --out diff.png \
  --overlay overlay.png \
  --json
```

HTML reports are offline, escape untrusted text, and link content-addressed local artifacts. Run
records contain hashes and provenance rather than embedded image/base64 payloads.

## Visual-regression baselines

Review first; approval is a separate command:

```bash
pnpm smart-ui baseline review \
  --target . \
  --run /absolute/path/to/run-record.json \
  --tenant tenant-a \
  --repository repository-a \
  --component Card \
  --viewport desktop \
  --state default \
  --json

pnpm smart-ui baseline approve \
  --target . \
  --run /absolute/path/to/reviewed-run-record.json \
  --tenant tenant-a \
  --repository repository-a \
  --component Card \
  --viewport desktop \
  --state default \
  --actor reviewer@example \
  --reason "Reviewed intentional token update" \
  --approve \
  --json
```

The manifest stores tenant/repository/component/viewport/state, artifact hash, actor, time, and reason.
There is no auto-approve mode.

## Governed memory

Memory and learning are disabled by default. Enable recall only with explicit identity and repository
scope. Candidates do not affect runs until confirmed.

```bash
pnpm smart-ui memory propose --target . --tenant local --user me \
  --scope repository:/absolute/repository/id \
  --value "Prefer existing spacing tokens"
pnpm smart-ui memory list --target . --tenant local --user me --json
pnpm smart-ui memory confirm <id> --target . --tenant local --user me
pnpm smart-ui memory explain <id> --target . --tenant local --user me
pnpm smart-ui memory correct <id> --value "Prefer component spacing tokens" \
  --target . --tenant local --user me
pnpm smart-ui memory export --target . --tenant local --user me --json
pnpm smart-ui memory forget <id> --target . --tenant local --user me
```

Add `--backend agent-memory` to memory commands or set `memory.backend` to `agent-memory`. Both the
governance JSON and Agent Memory SQLite stores are plaintext unless deployment wraps storage with the
provided encryption interface. See [governed memory](docs/memory.md).

## MCP server and coding hosts

Build and start the stdio server:

```bash
pnpm build
node /absolute/path/to/smart-ui-validator/apps/mcp-server/dist/index.js
```

The process communicates MCP JSON-RPC on stdin/stdout, so an interactive terminal appears idle. Use a
host or MCP inspector to call it. The stable tool surface is:

- Read-oriented: `inspect_project`, `plan_component`, `get_run`, `get_report`, `continue_run`,
  `list_memories`, `explain_memory`.
- Artifact/process-local state operations: `normalize_design`, `validate_component`,
  `answer_question`.
- Explicitly approval-gated mutations: `repair_component`, `confirm_memory`, `forget_memory`.

`repair_component` requires `approved: true` and a non-empty exact `allowWrite` list. The server has
no generic shell tool. `smart-ui://capabilities` declares transport/support status. Streamable HTTP is
not shipped because authentication, authorization, TLS termination, rate limits, and deployment
identity must be configured first.

All MCP filesystem inputs are constrained to the server process `cwd` or the narrower explicit
`SMART_UI_MCP_ROOT`. Run one server per trusted target workspace; never point this boundary at a home
directory or shared filesystem root. Question-answer handoff is process-local in 0.4.0 and capability
discovery explicitly reports that automatic cross-process run resumption is not shipped.

Copy and edit one setup example:

- [Codex config and AGENTS example](examples/hosts/codex/)
- [Claude Code project MCP config](examples/hosts/claude-code/)
- [VS Code/GitHub Copilot workspace config](examples/hosts/copilot/)
- [Optional disabled OpenClaw config](examples/hosts/openclaw/)

Replace every placeholder with an absolute trusted path. Never commit credentials. Codex supports
project `.codex/config.toml` in trusted repositories and write-aware MCP approval policy. Claude Code
uses project `.mcp.json` and prompts before trusting it. VS Code uses `.vscode/mcp.json`, supports
input variables, and can sandbox local MCP servers where supported. See [host setup](docs/hosts.md).

## Configuration

Place a strict `smart-ui.config.json` in the target root. Unknown keys, unsupported versions, invalid
URLs, unsafe thresholds, and shell-string commands fail validation.

```json
{
  "schemaVersion": "1.0",
  "validation": {
    "geometryTolerancePx": 2,
    "typographyTolerancePx": 1,
    "colorDeltaE": 2.5,
    "visualDifferencePercent": 0.75,
    "rasterChannelTolerance": 10,
    "textWrapMismatchAllowed": false,
    "requireNoConsoleErrors": true,
    "requireNoNetworkFailures": true,
    "requireKeyboardNavigation": true,
    "requireAccessibleNames": true,
    "minimumContrastRatio": 4.5,
    "maxRepairPasses": 5,
    "minimumScoreImprovement": 0.01
  },
  "evidence": {
    "maxElements": 2000,
    "maxTextLength": 4000,
    "maxConsoleMessages": 200,
    "maxFailedRequests": 200,
    "maxArtifactBytes": 20000000,
    "maxDiagnosticCharacters": 80000
  },
  "policy": {
    "allowedPaths": ["src/styles.css"],
    "allowedCommands": [
      { "executable": "pnpm", "args": ["typecheck"] },
      { "executable": "pnpm", "args": ["test"] }
    ],
    "endpointAllowlist": ["http://127.0.0.1:4173"],
    "blockExternalNetwork": true
  },
  "commands": {
    "format": null,
    "typecheck": { "executable": "pnpm", "args": ["typecheck"] },
    "test": { "executable": "pnpm", "args": ["test"] }
  },
  "viewports": [
    { "name": "desktop", "width": 800, "height": 600, "deviceScaleFactor": 1 },
    { "name": "tablet", "width": 768, "height": 1024, "deviceScaleFactor": 1 },
    { "name": "mobile", "width": 390, "height": 844, "deviceScaleFactor": 1 }
  ],
  "states": [
    { "name": "default" },
    { "name": "hover", "selector": "[data-validation-id='action']" },
    { "name": "focus", "selector": "[data-validation-id='action']" },
    { "name": "loading", "url": "http://127.0.0.1:4173?state=loading" }
  ],
  "masks": [{ "x": 0, "y": 0, "width": 100, "height": 24 }],
  "dynamicRegions": [
    { "selector": "[data-smart-ui-dynamic]", "reason": "Approved deterministic clock region" }
  ],
  "memory": {
    "enabled": false,
    "learningEnabled": false,
    "backend": "local",
    "storePath": ".smart-ui/memory.json",
    "agentMemoryDatabasePath": ".smart-ui/agent-memory.sqlite",
    "maxRecords": 12,
    "maxCharactersPerMemory": 800,
    "maxTotalCharacters": 6000,
    "telemetryEnabled": false,
    "remoteBackendEnabled": false
  },
  "enterprise": {
    "enabled": false,
    "requireAuthenticatedIdentity": true,
    "encryptionAtRestRequired": false,
    "auditLogPath": ".smart-ui/audit/events.jsonl",
    "telemetryEnabled": false,
    "remoteMcpEnabled": false,
    "channelIntegrationsEnabled": false,
    "retentionDays": { "artifacts": 30, "reports": 90, "audit": 365, "memory": 365 },
    "adminPolicy": {
      "allowedMemoryScopes": ["user", "repository", "project", "component", "session", "task"],
      "learningEnabled": false,
      "remoteDesignAccessEnabled": false,
      "externalModelProviders": [],
      "browserNetworkEnabled": false,
      "channelOutputEnabled": false
    }
  }
}
```

## Enterprise pilot controls and responsibilities

Implemented library controls include scope validation, opaque isolated storage roots,
deny-by-default action authorization, hash-chained audit events with redaction, injected
AES-256-GCM encryption, exportable records, retention/legal-hold hooks, non-overwriting verified
restore, exact allowlists, channel origin approval, and telemetry-off defaults.

Deployment owners must still provide authenticated identities, role assignments, KMS/key rotation,
TLS and authentication for any future remote MCP transport, encrypted volumes/backups, log shipping
and access control, legal retention policy, monitoring/alerting, incident ownership, secret manager,
network egress controls, and restore drills. Local JSON, artifacts, reports, audit files, and SQLite
are plaintext by default. Multi-process JSON writers are not coordinated. Do not describe a
deployment as compliant or certified without independent assessment.

Run `pnpm smart-ui audit-verify --path .smart-ui/audit/events.jsonl --json` to verify a local audit
chain. Backup/restore and retention are library APIs for an authenticated administrative adapter; no
destructive broad CLI command is exposed.

## Evaluation, CI, and release evidence

```bash
pnpm build
pnpm evaluate
pnpm security:secrets
pnpm package:check
pnpm audit --prod --audit-level high
pnpm sbom
```

The owned synthetic corpus covers React and Angular, responsive and interaction states, fidelity,
component correctness/reuse, accessibility regression, convergence/rollback, context/tokens,
latency/browser time/artifact volume, memory precision, leakage, and prompt-injection resistance.
`pnpm evaluate` writes `evaluation-scorecard.json` and exits `3` when a release threshold fails.
Checked-in observations are the reviewed v1 reference scorecard inputs; real pilot runs should replace
them with measured observations from the same strict schema before release approval.

CI runs formatting, lint, typecheck, production builds, unit/integration tests, real Chromium E2E,
evaluation, secret scanning, package-content inspection, production dependency audit, and local SBOM
generation. Release tags create candidate tarballs only; publishing requires a separate approved
environment. See [evaluation](docs/evaluation.md) and [release process](docs/release.md).

## Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | Command completed and no blocking validation finding remains.                 |
| `1`  | Unexpected command/runtime failure.                                           |
| `2`  | Invalid user input or strict schema/config error.                             |
| `3`  | Validation/evaluation completed but blocking findings or failed gates remain. |
| `4`  | A run/doctor/audit operation failed or the evidence is not trustworthy.       |

## Troubleshooting

- **Chromium missing:** run `pnpm exec playwright install chromium`, then `smart-ui doctor`.
- **Chromium permission failure on macOS sandbox:** run the test/host in an environment allowed to
  launch Playwright's isolated child process. Do not attach to a personal Chrome profile.
- **Route blocked:** add only the exact origin/path required to `endpointAllowlist`; do not disable
  external network policy globally.
- **Write rejected:** use a target-relative exact filename in `allowedPaths` or `--allow-write`.
- **Command rejected:** match executable and every argument exactly in both `allowedCommands` and
  the selected post-patch command.
- **Dynamic region rejected:** add a narrow selector plus a documented reason; do not mask the whole
  component.
- **Focus state needs a selector:** pass `--selector` or configure it in `states`.
- **MCP server appears idle:** stdio is waiting for an MCP client; configure a host or inspector.
- **Host cannot start server:** build first, use an absolute `dist/index.js` path, restart the host,
  and inspect its MCP logs/tool list.
- **MCP path rejected:** start the server with the target repository as `cwd`, or set
  `SMART_UI_MCP_ROOT` to that one trusted target; symlinks and paths outside it are rejected.
- **`--out` already exists:** RunRecord output is non-overwriting. Choose a new path or intentionally
  archive the existing evidence before retrying.
- **Agent Memory warning:** Node reports its built-in SQLite API as experimental; use local JSON if
  that is not acceptable.
- **Restore refuses to run:** restore is intentionally non-overwriting and scope-bound. Choose an
  empty destination and supply the same encryption provider/context.
- **HTML report cannot find an image:** pass the artifact directory that created the run; artifacts
  are content addressed and paths are store-relative.

## Development and complete verification

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm evaluate
pnpm security:secrets
pnpm package:check
pnpm audit --prod --audit-level high
pnpm sbom
```

The E2E suite starts both representative fixture servers, exercises isolated Chromium at responsive
viewports and interaction state, verifies deterministic artifacts/reports, and terminates the local
servers. Live Figma, Chrome DevTools MCP, Codex, Claude Code, Copilot, OpenClaw, Slack, remote MCP,
external model, and organization authentication checks require user-controlled credentials and are
not claimed by CI.

Further documentation: [architecture](docs/architecture.md), [MCP](docs/mcp.md),
[host setup](docs/hosts.md), [security](docs/security.md), [threat model](docs/threat-model.md),
[operations](docs/operations.md), [memory](docs/memory.md), [development](docs/development.md), and
the authoritative [implementation plan](docs/implementation-plan.md).
