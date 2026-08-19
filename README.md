# Smart UI Validator

Smart UI Validator is a host-neutral CLI and engine for two related but separate UI workflows:

1. **Validate and repair an existing React or Angular implementation** against design evidence.
2. **Generate standalone HTML and CSS from a local SVG or PNG** without requiring an application repository.

Both workflows use the same safety, artifact, browser, comparison, and reporting foundations. They do
not have the same inputs or outputs, and you can use either one independently.

The package also includes **Smart UI Studio**, a local browser interface for the SVG/PNG-to-HTML
workflow. Studio is not a hosted service and is not a separate generation engine.

> Smart UI Validator is currently intended for a controlled local or internal pilot. Review its
> evidence and proposed changes before treating an output as production-ready.

## Choose the workflow you need

|                            | Existing UI validation and repair                                      | SVG/PNG-to-HTML generation                                            |
| -------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Use it when                | A UI already belongs in a React or Angular project                     | A local SVG or PNG should become a standalone HTML/CSS bundle         |
| Primary input              | Design evidence, target repository, and a running browser route        | One bounded SVG/PNG plus optional UTF-8 design context                |
| Repository required        | Yes                                                                    | No                                                                    |
| Running application        | Yes, for browser capture                                               | No; Smart UI creates a contained preview                              |
| Model or MCP host required | No for CLI validation; useful for substantial implementation proposals | No for deterministic mode; required for CLI or Studio agent authoring |
| Main command               | `smart-ui validate`, `smart-ui validate-matrix`, or `smart-ui fix`     | `smart-ui generate`                                                   |
| Visual interface           | No dedicated UI                                                        | `smart-ui studio`                                                     |
| Main result                | Findings, screenshots, diffs, overlays, run records, and reports       | HTML/CSS, evidence, report, immutable record, and reproducible ZIP    |
| Writes application source  | Only during an explicitly bounded repair                               | Never                                                                 |

## What Smart UI does—and where AI fits

Smart UI Validator does not ship a general-purpose AI model. Deterministic code performs the work
that must be reproducible: input validation, browser capture, DOM and computed-style collection,
image comparison, scoring, policy enforcement, rollback decisions, artifact hashing, and reporting.

An MCP-compatible host such as Codex, Claude Code, or VS Code/Copilot can inspect the compact
evidence and propose an implementation or repair. Those proposals still pass through Smart UI's
exact path, command, endpoint, pass-count, and regression boundaries. The bundled heuristic repair
provider is intentionally narrow; substantial repository edits are expected to come from a capable
host agent and require approval for the exact files involved.

## Requirements and installation

- Node.js 22.16 or newer.
- Playwright Chromium, provisioned and launch-tested by `smart-ui setup` for repository validation.
- pnpm 10.15.0 only when building this repository from source.
- A React or Angular project only for the validation/repair workflow.

Install the CLI in a project or tooling workspace:

```bash
npm install --save-dev smart-ui-validator@0.4.2
npx smart-ui --help
```

The package has no browser-downloading `postinstall` hook. For the SVG CLI or Studio from another
directory, you can invoke the published package explicitly:

```bash
npx --package smart-ui-validator@0.4.2 smart-ui --help
```

From this repository checkout, use `pnpm smart-ui` after `pnpm install --frozen-lockfile` and
`pnpm build`.

---

## Functionality 1: validate and repair an existing UI

Use this workflow when the final implementation must live in an existing React or Angular project
and follow that project's components, tokens, routes, styling, state, and test conventions.

### What it evaluates

Smart UI renders the requested route in isolated Chromium and produces deterministic findings across:

- geometry and layout, including element bounds, spacing, alignment, overflow, and text wrapping;
- typography and computed appearance, including fonts, line height, weight, color, and contrast;
- assets and raster similarity, including a screenshot, difference image, and overlay;
- structure and accessibility, including accessible names, duplicate IDs, and keyboard focus;
- runtime behavior, including console errors and failed network requests;
- configured viewports and default, hover, focus, active, disabled, loading, empty, and error states.

A PNG, JPEG, WebP, or SVG reference without a structural sidecar provides raster evidence only.
Smart UI will not invent exact semantic or box-model expectations that are absent from the source.

### How it works

1. `inspect` discovers the target framework and relevant repository conventions.
2. `design normalize` turns local evidence into a versioned `DesignContract` with provenance.
3. `validate` captures one browser state, or `validate-matrix` captures the configured viewport and
   interaction-state matrix.
4. Deterministic comparators produce categorized findings and immutable evidence artifacts.
5. `fix` may apply a bounded, allowlisted proposal, run configured checks, recapture the UI, and
   retain or roll back the proposal based on deterministic regression evidence.
6. An offline report and versioned `RunRecord` preserve the result and its provenance.

### Quick start

Run first-time setup from the target repository. Add `--agent-memory` only if you intend to use the
optional embedded-SQLite memory backend.

```bash
npm install --save-dev smart-ui-validator@0.4.2
npx smart-ui setup --target .
npx smart-ui doctor --target .
npx smart-ui inspect --target . --json
```

Create `smart-ui.config.json` in the target root. This minimal example allows two exact source files
and one exact test command; omitted settings use strict defaults.

```json
{
  "schemaVersion": "1.0",
  "validation": {
    "maxRepairPasses": 5,
    "visualDifferencePercent": 0.75,
    "colorDeltaE": 2.5
  },
  "policy": {
    "allowedPaths": ["src/components/PricingCard.tsx", "src/components/PricingCard.css"],
    "allowedCommands": [{ "executable": "npm", "args": ["test"] }],
    "endpointAllowlist": [],
    "blockExternalNetwork": true
  },
  "commands": {
    "format": null,
    "typecheck": null,
    "test": { "executable": "npm", "args": ["test"] }
  }
}
```

Normalize the design evidence:

```bash
npx smart-ui design normalize \
  --image /absolute/path/to/reference.png \
  --out /absolute/path/to/project/.smart-ui/design-contract.json \
  --artifacts /absolute/path/to/project/.smart-ui/artifacts
```

If you have explicit element evidence, add `--spec /absolute/path/to/spec.json`. Start the target
application yourself, then validate its fully qualified loopback route:

```bash
npx smart-ui validate \
  --target /absolute/path/to/project \
  --design /absolute/path/to/project/.smart-ui/design-contract.json \
  --route http://127.0.0.1:4173/pricing \
  --out /absolute/path/to/project/.smart-ui/run.json
```

For all configured viewports and states:

```bash
npx smart-ui validate-matrix \
  --target /absolute/path/to/project \
  --design /absolute/path/to/project/.smart-ui/design-contract.json \
  --route http://127.0.0.1:4173/pricing
```

For a bounded repair run, explicitly allow every file that may be written. Paths can come from the
configuration or from `--allow-write`:

```bash
npx smart-ui fix \
  --target /absolute/path/to/project \
  --design /absolute/path/to/project/.smart-ui/design-contract.json \
  --route http://127.0.0.1:4173/pricing \
  --allow-write src/components/PricingCard.tsx src/components/PricingCard.css \
  --max-passes 3
```

Use `--dry-run` to record a proposal without source writes. A retained repair is not based on one
headline score: configured repository checks must pass, structural evidence must not regress, and
the visual result must improve within the configured thresholds. Existing and newly created files
are rolled back when a proposal is rejected or a pass fails.

### Using an MCP host

The MCP server exposes the same core through compact, approval-aware tools. A host agent is the
recommended way to produce non-trivial React or Angular changes from the findings.

Example `.mcp.json` for Claude Code:

```json
{
  "mcpServers": {
    "smart-ui": {
      "command": "npx",
      "args": ["-y", "smart-ui-validator-mcp@0.4.2"],
      "cwd": "/absolute/path/to/project",
      "env": {
        "SMART_UI_MCP_ROOT": "/absolute/path/to/project"
      }
    }
  }
}
```

For a guided first run, create the target-contained workflow manifest from this repository:

```bash
pnpm workflow:setup -- \
  --target /absolute/path/to/project \
  --design /absolute/path/to/reference.svg \
  --url http://127.0.0.1:4173/pricing \
  --component PricingCard \
  --host codex \
  --ensure-engine
```

Then ask the connected host to call `prepare_workflow`, plan the component, establish a validation
baseline, and request approval before each repair batch. See the
[agent-first workflow](docs/agent-workflow.md) and [host setup guide](docs/hosts.md).

### What to expect

- A versioned `DesignContract` and `RunRecord`, with hashes and provenance.
- Target and implementation screenshots, raster diff and overlay images, categorized findings, and
  an offline HTML report.
- Separate visual similarity and binary check results; Smart UI does not ask a model to invent a
  score.
- Bounded repair passes with explicit stop conditions and reviewable immutable pass records.
- Exact writable-file and command enforcement, browser isolation, artifact budgets, timeouts, and
  rollback on rejected changes.
- Optional governed memory for confirmed, scoped preferences. Memory is advisory, disabled by
  default, inspectable, correctable, forgettable, and never a source of new permissions.

Do not expect Smart UI to replace application tests, infer missing design semantics from pixels, or
guarantee that every design can reach zero raster difference. Dynamic content, unavailable fonts,
browser rendering, source evidence, and application state can all constrain the achievable result.

---

## Functionality 2: generate standalone HTML and CSS from an SVG or PNG

Use this workflow when the input is a local SVG or PNG and the desired result is a self-contained web
bundle. It is repository-free: it does not inspect or modify a React or Angular project, start your
application, require Figma, or require a model.

You can access this functionality through:

- the `smart-ui generate` CLI for repeatable SVG/PNG runs;
- SVG generation tools in the stdio MCP server for an approval-aware direct-tool workflow; or
- Smart UI Studio for a visual SVG/PNG workflow with optional connected-agent authoring.

The direct `inspect_svg`/`generate_html_from_svg` MCP tools remain SVG-specific. PNG reaches the same
core through CLI or Studio, where Studio attaches the original PNG to its authoring request.

All three interfaces call the same public `GenerationOrchestrator` and produce the same versioned
generation records and deterministic evidence.

### How generation works

1. Smart UI verifies that the declared workspace, SVG/PNG reference, optional source-context file,
   artifact root, and optional export directory are contained and safe.
2. It streams and sanitizes SVG under strict structural limits. PNG uses a lighter bounded signature
   and dimension check, then remains immutable raster evidence; it contains no executable markup.
3. It creates a hierarchical `DesignBundle` 2.0 with scene structure, repeated values, layout and
   semantic candidates, typed design context, explicit presentation intent, provenance, and
   uncertainties. Supported 1.0 bundles are upgraded to intrinsic presentation deterministically.
4. A deterministic provider generates bounded local HTML/CSS according to the selected mode and
   layout.
5. Smart UI serves the output on a short-lived contained loopback preview with browser networking
   blocked, captures it in Chromium, and compares it with the source SVG.
6. It retains an immutable `GenerationRecord`, offline report, evidence images, generated files, and
   reproducible ZIP. An optional export copies only the accepted manifest into one exact new empty
   directory.

### Generation modes

| Mode       | Best fit                                               | Expected trade-off                                                                       |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `exact`    | Artwork-heavy SVGs, outlined text, and complex effects | Prioritizes source-viewport visual fidelity and preserves more SVG-native representation |
| `hybrid`   | General screens with both structure and visual artwork | Balances readable HTML/CSS with preserved complex visual subtrees; recommended default   |
| `semantic` | Readable UI screens where HTML meaning matters most    | Produces the strongest bounded semantic projection; narrow visual fidelity may be lower  |

Layout choices are `fixed`, `responsive`, and `component`. A source SVG normally proves fidelity
only at its source viewport. A narrow rendering without a corresponding narrow source is reported
as **responsive robustness**, not as visual fidelity to an unprovided design.

An optional `PresentationSpec` separates source dimensions from the target canvas. It records a
stable canvas ID, exact CSS-pixel width and height, DPR, `intrinsic`/`contain`/`cover`/`stretch` fit,
alignment, and up to eight named validation viewports. The source reference, generated output,
preview, screenshot, diff, and overlay use the same primary-canvas rules. Without this spec, the
legacy intrinsic behavior is preserved.

An optional `StructuredDesignContext` carries bounded exact copy, design tokens, component
semantics, interactions, provenance, and general notes through CLI, MCP, Studio, authoring rounds,
the design bundle, and reports. All fields are validated as untrusted evidence and each authoring
round records the validated original context hash plus whether credential-like text was redacted.
An additional optional UTF-8 design-context file may contain JSX, TSX, HTML, CSS, JSON, Markdown, or
plain text. Studio passes its redacted content to the connected authoring agent with the SVG/PNG
evidence. The deterministic CLI records the same bounded, redacted source and original hash as an
immutable provenance artifact; it does not claim to interpret source code without an agent. With
`--engine agent`, it sends both inputs through the shared MCP authoring queue before deterministic
verification.

### Generate from the CLI

The SVG or PNG must be inside the exact workspace. `--output` is optional; when supplied, it must
name a new empty directory inside that workspace.

```bash
npx smart-ui generate \
  --workspace /absolute/path/to/svg-workspace \
  --design /absolute/path/to/svg-workspace/design/pricing.png \
  --design-context /absolute/path/to/svg-workspace/design/Pricing.jsx \
  --structured-context /absolute/path/to/svg-workspace/design/context.json \
  --engine agent \
  --output /absolute/path/to/svg-workspace/generated/pricing \
  --mode hybrid \
  --layout responsive \
  --name "Pricing screen"
```

Useful options:

- `--engine deterministic|agent` selects the built-in generator or the MCP-connected authoring
  queue. Agent mode prints an exact handoff prompt, waits for `list_studio_authoring_requests` and
  `submit_studio_authored_html`, then renders and compares the returned files. Its workspace must be
  inside the MCP server's `SMART_UI_MCP_ROOT`.
- `--agent-timeout <milliseconds>` bounds that wait from 1 second to 1 hour. Timeout or cancellation
  removes the queued request and temporary evidence. Agent mode requires `--max-passes 1` so its
  proposal is evaluated; deterministic mode remains the default.
- `--instructions <text>` adds one bounded implementation note.
- `--design-context <path>` reads a contained, non-empty UTF-8 source-context file up to 250 KB.
  JSX, TSX, HTML, CSS, JSON, Markdown, and plain text are supported; credential-like values are
  redacted before retention. For compatibility, a valid `StructuredDesignContext` 1.0 JSON file
  supplied here is still recognized as typed context.
- `--structured-context <path>` explicitly reads a contained `StructuredDesignContext` 1.0 JSON
  file and can be used together with the free-form source context.
- `--presentation <path>` reads a contained `PresentationSpec` 1.0 JSON file.
- `--viewport <width>x<height>` overrides the source viewport when the SVG does not provide the
  intended dimensions.
- `--max-passes 0|1` controls the bounded revision count.
- `--dry-run --json` performs safety and capability inspection without producing a deliverable;
  it never queues an agent request, even when `--engine agent` is supplied, and its compact result
  includes retained design-reference and source-context artifact metadata.
- Omitting `--output` retains the immutable artifact run, report, and ZIP without materializing a
  separate export directory.

### Generate through MCP

Connected hosts use the same engine and do not receive a generic browser, shell, or file-writer tool.
`inspect_svg` and `generate_html_from_svg` accept the same structured design context and presentation
specification as the CLI:

- `inspect_svg` returns compact capabilities and a paged normalized context handle.
- `generate_html_from_svg` generates deterministically and can consider one optional, explicitly
  approved host HTML/CSS/SVG proposal.
- `get_generation` and `get_generation_report` retrieve bounded records and evidence.
- `export_generation` requires a separate approval for the accepted manifest hash, every relative
  path, and one exact new empty destination.

Read the MCP resource `smart-ui://svg-generation-guide` before using this flow. Host proposals are
rendered and compared by Smart UI and are retained only when they do not introduce structural or
visual regression; the host never scores its own output.

### What to expect

- Generated `index.html` and `styles.css` using local files only.
- A reproducible ZIP, optional exact-directory export, and downloadable offline report.
- Source and implementation screenshots, visual mismatch, difference heatmap, overlay, structural
  findings, runtime/accessibility findings, and viewport classifications.
- An immutable generation record containing file manifests, hashes, decisions, uncertainties,
  provenance, pass history, stop reason, and artifact references.
- A fail-closed rejection instead of partial output for unsafe, unsupported, oversized, or
  out-of-bound input.

Generation is deterministic and bounded, but it is not a full design-to-production application
builder. It does not add application state, backend behavior, routing, design-system integration, or
business logic that is not represented by the design evidence and bounded context.

---

## Smart UI Studio

Smart UI Studio is the packaged local browser interface for SVG/PNG-to-HTML generation. It is designed
for teammates who want to upload, configure, review, and download a generation without composing CLI
arguments. Its deterministic engine needs no MCP host; agent authoring uses the connected MCP chat.

Studio is not used to validate or repair an existing React or Angular repository. It has no hosted
backend, account system, remote collaboration, Figma or model credential collection, or telemetry.

### How Studio works

The CLI starts a private server on an ephemeral `127.0.0.1` port and prints the exact URL. The browser
receives a random process capability in an HTTP-only, same-site cookie and uses a separate CSRF
token. Studio checks the exact host, origin, method, and content type, exposes no CORS access, and
never accepts a filesystem path from page JavaScript.

Each upload receives an opaque run ID and separate server-owned inspection and generation artifact
roots. SVG is streamed and structurally sanitized; PNG is size-bounded and checked for a valid
signature and dimensions before being retained as immutable raster evidence. Generated source
is displayed as escaped text, while the accepted page runs on a separate CSP-restricted preview
origin with scripts and network access denied. Browser state is only a view of the persisted
generation record, so completed runs can be recovered after Studio restarts.

An inspected run may also receive one optional design-context source file, commonly JSX or TSX but
not restricted by extension. Studio accepts only bounded UTF-8 text, stores it inside that run,
records its filename, media type, byte size, hash, and provenance, and redacts credential-like text
before including it in the MCP authoring request and generation record. Binary and oversized context
files fail closed.

### Generation engines

Studio offers two engines on the Preferences step:

- **AI agent (default):** the chat agent connected to this repository's `smart-ui` MCP server authors
  the HTML and CSS. Studio writes a bounded authoring request into its workspace, the agent picks it
  up with `list_studio_authoring_requests`, authors offline files sized to the design's exact canvas,
  and returns them with `submit_studio_authored_html`. Studio then renders and measures the result
  through the same deterministic pipeline. While a run waits, Studio shows a ready-to-paste prompt —
  containing the workspace path and run ID — to hand to the MCP-connected chat.
- **Deterministic:** the built-in bounded generator; no model is involved.

Because the agent reaches the queue through `SMART_UI_MCP_ROOT`, the Studio workspace must live inside
the MCP root. Running Studio from this repository checkout satisfies this by default (see below).

### Start Studio

Studio initializes a dedicated workspace automatically. From this repository checkout, the default
workspace is `<cwd>/.studio-workspace`, which is already inside the MCP root, so the agent engine
works with no extra flags. To verify the local engine, create an absent host configuration safely,
initialize the dedicated workspace, and start Studio in one command, use `--agent`:

```bash
npx smart-ui studio --agent --host codex
```

Use `--host claude` or `--host copilot` for their project configuration formats. `--dry-run` previews
without writes, `--check-only` diagnoses only, and `--ensure-engine` explicitly installs the pinned
Chromium revision and rebuilds stale source-checkout assets. A differing existing `.codex/config.toml`,
`.mcp.json`, or `.vscode/mcp.json` is never overwritten. The equivalent read-only diagnosis is
`smart-ui doctor --studio-agent --host <host> --workspace <path> --json`.

Studio refuses filesystem roots, your home directory, symlink roots, and non-empty directories that
it did not initialize. To use an explicit dedicated directory, or to initialize/verify without
starting, pass `--workspace`:

```bash
npx smart-ui studio --workspace /absolute/path/to/smart-ui-studio --init-only

npx smart-ui studio --workspace /absolute/path/to/smart-ui-studio --health-check --json

npx smart-ui studio --workspace /absolute/path/to/smart-ui-studio --open
```

Without `--open`, Studio starts headless and prints the local URL for you to open manually. Stop it
with `Ctrl+C`. After rebuilding the MCP server, restart it in your host (in VS Code: **MCP: List
Servers → smart-ui → Restart**) so new tools and evidence are picked up.

`--retention-hours <hours>` controls expiry for completed local runs and defaults to 24 hours.
`--port <port>` requests an exact loopback port; the default `0` is safer for concurrent runs because
the operating system chooses an available ephemeral port.

### The four Studio steps

1. **Input:** drag, drop, or choose one `.svg` or `.png`, plus optional UTF-8 design context. Studio
   verifies it and shows dimensions, hashes, scene size, readable text, decisions, uncertainties,
   and recommended modes.
2. **Preferences:** optionally attach the JSX, TSX, HTML, CSS, JSON, Markdown, or other UTF-8 design
   context supplied with the design reference; choose the engine, generation mode, and layout;
   choose intrinsic or custom canvas, DPR, fit, alignment, and bounded named viewports; and enter
   structured exact copy, tokens, component semantics, interactions, and an optional compatibility
   note.
3. **Generate:** follow sanitization, inspection, generation, preview, comparison, packaging, and
   reporting progress. With the AI-agent engine, the run pauses on an `awaiting-agent` step that shows
   the prompt to paste into the MCP-connected chat. You can cancel an in-flight run.
4. **Review:** inspect the isolated preview, visual similarity/mismatch, viewport classifications,
   source code, findings, uncertainties, generated-output screenshot, heatmap, and overlay. Download
   individual accepted files, the reproducible ZIP, or the offline report.

The review screen can delete exactly one verified run. Expiry and deletion close its preview, cancel
in-flight work, remove only that run directory, and verify that it is gone.

### What to expect from Studio

- The same generated files, deterministic comparison, report, ZIP, and `GenerationRecord` as the CLI.
- No model-generated score and no hidden cloud processing.
- Local-only access while the Studio process is running.
- Plaintext local run data inside the dedicated workspace. Use OS-level disk protection when local
  artifact confidentiality matters.
- A clear error and recovery message for unsafe SVGs, unsupported input, cancellation, interrupted
  work, or a failed health dependency.
- No repository source edits and no conversion of the output into a React or Angular application.

## Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| `0`  | Success; no blocking validation or generation finding remains             |
| `1`  | Unexpected command or runtime failure                                     |
| `2`  | Invalid input or strict schema/configuration error                        |
| `3`  | Work completed, but blocking deterministic findings remain                |
| `4`  | The operation failed or the target/runtime environment is not trustworthy |

## Troubleshooting

- **Chromium is missing or cannot launch:** run `npx smart-ui setup --target <project>`. Studio users
  can run `smart-ui studio --workspace <workspace> --health-check --json` for a real launch check.
- **A repair write is rejected:** allow the exact target-relative file in `policy.allowedPaths` or
  pass it with `--allow-write`; do not allowlist the repository root.
- **A configured command is rejected:** the executable and every argument must exactly match both
  the command configuration and `policy.allowedCommands`.
- **The route captures the wrong area:** use a stable fixture/Storybook route and scope the component
  with `data-validation-id="pricing-card"` where appropriate.
- **MCP rejects a path:** keep evidence and artifacts inside `SMART_UI_MCP_ROOT`; do not broaden the
  root to a home directory.
- **Studio refuses its workspace:** choose a new empty dedicated directory or initialize it with
  `--init-only`. Do not use `/`, a drive root, your home directory, or a symlink root.
- **Studio data persists after shutdown:** this is expected. Completed records are recoverable until
  the UI deletes the run or retention expires it.
- **Agent Memory fails:** Node's embedded SQLite is used; no external database server is required.
  Run `smart-ui setup --target <project> --agent-memory` to exercise the persistence canary.

## Documentation

- [Architecture and interfaces](docs/architecture.md)
- [Agent-first validation workflow](docs/agent-workflow.md)
- [SVG-to-HTML generation plan and guarantees](docs/svg-to-html-generation-plan.md)
- [MCP server](docs/mcp.md)
- [Host integrations](docs/hosts.md)
- [Security controls](docs/security.md)
- [Threat model](docs/threat-model.md)
- [Governed memory](docs/memory.md)
- [Operations and Studio lifecycle](docs/operations.md)
- [Evaluation](docs/evaluation.md)
- [Release process](docs/release.md)
- [npm publishing](docs/npm-publishing.md)
- [Local development and testing](docs/development.md)
- [Authoritative implementation plan](docs/implementation-plan.md)

## License

MIT
