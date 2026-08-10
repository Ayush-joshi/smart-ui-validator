# `smart-ui-validator`

Command-line interface for Smart UI Validator.

## Requirements

- Node.js 22.16 or newer.
- Network access during first-time setup if the pinned Chromium revision is not already cached.
- A React or Angular target repository for validation/repair, or a dedicated local workspace for
  repository-free SVG generation.

No standalone SQLite installation or database service is required. Agent Memory uses Node's
embedded SQLite support and remains optional.

## First-time setup

```bash
npm install --save-dev smart-ui-validator@0.4.2
npx smart-ui setup --target . --agent-memory
npx smart-ui doctor --target .
```

`setup` uses the Playwright installation code shipped with this package's exact core dependency. It
downloads the matching Chromium revision only when the browser cannot already launch, then repeats
a real launch canary. The optional `--agent-memory` flag performs a disposable embedded-SQLite
persistence canary. Use `--json` for machine-readable output without download progress.

The package deliberately has no browser-downloading `postinstall` hook: installing JavaScript
dependencies must not unexpectedly download a large binary or fail solely because a proxy is
offline. A setup or doctor readiness failure exits with code `4`.

## Usage

```bash
npx smart-ui-validator doctor --target /absolute/project
npx smart-ui-validator inspect --target /absolute/project --json
```

The CLI can normalize local design evidence, validate one state or a viewport/state matrix, apply
approval-bounded repairs, generate reports, manage governed memories, and verify audit records.

Generate an offline standalone bundle directly from a local SVG:

```bash
npx smart-ui generate \
  --workspace /absolute/svg-workspace \
  --design /absolute/svg-workspace/screen.svg \
  --output /absolute/svg-workspace/generated/screen \
  --mode hybrid \
  --layout responsive
```

The workspace is never inferred from common path ancestors. Without `--output`, only the unique
immutable artifact run, offline report, and ZIP are retained. An explicit output must be a new empty
directory inside the workspace. `--dry-run` sanitizes and inspects but writes no deliverable.
`--mode semantic` enables the Phase 2 semantic mode; `--max-passes` remains bounded to 0 or 1 and
the built-in deterministic provider completes without inventing an agent loop.

Run `smart-ui --help` for the complete command list. This README documents the supported setup
workflow; the CLI help lists every available command.
