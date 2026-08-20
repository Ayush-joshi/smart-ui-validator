# `smart-ui-validator`

Command-line interface for Smart UI Validator's two independent workflows:

- deterministic validation and bounded repair of an existing React or Angular UI; and
- repository-free generation of standalone HTML/CSS from a local SVG or PNG.

The package also contains Smart UI Studio, a local browser interface for both workflows. Studio is
bundled inside this CLI package rather than published as a separate service or package.

## Requirements

- Node.js 22.16 or newer.
- Network access during first-time setup if the pinned Chromium revision is not already cached.
- A React or Angular target and running route only for validation/repair.
- A dedicated local workspace for generation and Studio state.
- An explicit React/Angular repository root only when Studio Validate UI is enabled.

No standalone SQLite installation or database service is required. Agent Memory uses Node's
embedded SQLite support and remains optional.

## Installation

```bash
npm install --save-dev smart-ui-validator@0.5.1
npx smart-ui --help
```

The package deliberately has no browser-downloading `postinstall` hook. Installing JavaScript
dependencies must not unexpectedly download a large binary or fail only because a proxy is offline.

## Existing UI validation and repair

Provision and verify the target environment:

```bash
npx smart-ui setup --target .
npx smart-ui doctor --target .
npx smart-ui inspect --target . --json
```

`setup` uses the Playwright installation code shipped with this package's exact core dependency. It
downloads the matching Chromium revision only when the browser cannot already launch, then repeats a
real launch canary. Add `--agent-memory` only to exercise the optional embedded-SQLite persistence
canary. A readiness failure exits with code `4`.

Normalize local evidence and validate a running route:

```bash
npx smart-ui design normalize \
  --image /absolute/project/reference.svg \
  --out /absolute/project/.smart-ui/design-contract.json \
  --artifacts /absolute/project/.smart-ui/artifacts

npx smart-ui validate \
  --target /absolute/project \
  --design /absolute/project/.smart-ui/design-contract.json \
  --route http://127.0.0.1:4173/component
```

Use `validate-matrix` for configured viewports/states and `fix` for approval-bounded repairs. Repair
writes are limited to exact target-relative paths from configuration or `--allow-write`; configured
commands require an exact executable/argument allowlist. Smart UI retains deterministic screenshots,
diffs, overlays, findings, a `RunRecord`, and an offline report, and rolls back rejected proposals.

For a substantial implementation authored by an agent or human, use `validate-ui prepare` and
`validate-ui review`. The persistent task pins the route, evidence, repository inspection, and exact
writable files; review creates an immutable attempt, and `task accept` records the explicit decision.

## SVG-to-HTML generation

This workflow does not inspect or modify an application repository and does not require Figma, MCP,
a model, or a running application.

```bash
npx smart-ui generate \
  --workspace /absolute/svg-workspace \
  --design /absolute/svg-workspace/screen.svg \
  --output /absolute/svg-workspace/generated/screen \
  --mode hybrid \
  --layout responsive
```

The workspace is never inferred from common path ancestors. Without `--output`, only the unique
immutable artifact run, offline report, and reproducible ZIP are retained. An explicit output must be
a new empty directory inside the workspace. `--dry-run --json` sanitizes and inspects without
producing a deliverable.

For agent- or human-authored standalone output, use `generation prepare`, author only the task's exact
proposal manifest, then run `generation review` and `task accept`. This persistent flow does not
invoke a model or require MCP; a connected MCP agent can submit to the same task contract.

Modes are `exact`, `hybrid`, and `semantic`; layouts are `fixed`, `responsive`, and `component`.
Source-viewport fidelity is measured separately from narrow responsive robustness. The result
contains `index.html`, `styles.css`, deterministic evidence, uncertainties, findings, hashes,
provenance, and an immutable `GenerationRecord`.

## Smart UI Studio

Studio is the local visual interface for standalone SVG/PNG generation and bounded validation of an
explicitly configured React/Angular target. It is not a hosted backend, model host, or remote
collaboration service.

Studio initializes a dedicated workspace automatically. From a repository checkout it defaults to
`<cwd>/.studio-workspace` (inside the MCP root), so its default connected-agent handoff — powered by
the `smart-ui` MCP server — works with no flags:

```bash
npx smart-ui studio
```

Pass `--workspace` to use an explicit dedicated directory, or to initialize/verify without starting:

```bash
npx smart-ui studio --workspace /absolute/smart-ui-studio --init-only
npx smart-ui studio --workspace /absolute/smart-ui-studio --health-check --json
npx smart-ui studio --workspace /absolute/smart-ui-studio --open
npx smart-ui studio \
  --workspace /absolute/smart-ui-studio \
  --target /absolute/react-or-angular-repository \
  --open
npx smart-ui studio --review-task /absolute/task.json --open
```

Studio binds only to `127.0.0.1`, starts headless unless `--open` is explicit, and never lets page
JavaScript select or widen a filesystem root. Start with `--target <absolute-repository>` to enable
Validate UI. Both work types use Work type, Inputs, Preferences and boundaries, Handoff, and Review.
They share bounded SVG/PNG upload and upload-or-paste context controls. Validate UI stages its design
upload inside the target only long enough for core task intake, then removes staging; repository
writes remain exact and target-relative.

`--retention-hours` defaults to 24 hours. Runs are recoverable after restart and can be deleted one at
a time from the UI. Local Studio storage is plaintext, telemetry is off, and no credentials are
collected.

## More documentation

Run `smart-ui --help` for every command and option. The repository
[README](../../README.md) provides complete workflow examples and expectations; see
[architecture](../../docs/architecture.md), [MCP](../../docs/mcp.md),
[security](../../docs/security.md), and [operations](../../docs/operations.md) for the underlying
contracts and boundaries.
