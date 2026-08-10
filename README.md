# Smart UI Validator

**Smart UI Validator** is a host-neutral orchestration engine and CLI that turns your AI assistant (like Claude Code, GitHub Copilot, or Codex) into a highly disciplined, visually-aware frontend developer.

It introduces **Test-Driven Development (TDD) for Visuals**: You provide a Figma design or reference image, and the Validator mathematically ensures the UI code your AI writes matches the design pixel-for-pixel, automatically applying fixes and rolling back failures—all without breaking your repository rules.

---

## 🧠 What is this? (And where is the AI?)

**Smart UI Validator does NOT contain an AI model.** It is a strict sandbox, a deterministic measurement engine, and a memory store built specifically _for_ AI models.

You bring your own AI model (BYOM) via the **Model Context Protocol (MCP)**.

1. **The Brains (Your AI Model):** You chat with Claude Code or VS Code Copilot.
2. **The Protocol (MCP):** Your AI communicates with Smart UI Validator via standard input/output.
3. **The Brawn (Smart UI Validator):** The Validator intercepts the AI's actions. If the AI writes a UI component, the Validator boots up an isolated Chromium browser, takes a screenshot, mathematically compares it to the Figma design, and tells the AI exactly what to fix (e.g., _"The gap is 8px instead of 16px"_).

---

## 🔬 How it Evaluates (It is NOT just a screenshot tool)

Smart UI Validator does not just take a blurry screenshot and ask the AI "does this look right?". It acts like a headless browser and deeply evaluates the **DOM, HTML, CSS, and runtime state**.

1. **Geometry & Layout (The DOM Box Model):** It measures the exact rendered pixels between elements, bounding box intersections, flexbox alignments, and overflow boundaries.
2. **Typography & Computed Styles (CSS):** It extracts the computed styles to ensure font-family, exact font-weight, line-height, text-wrapping, and color _Delta E_ (human perceptual color difference) perfectly match the design constraints.
3. **Accessibility & Semantics (HTML):** It audits missing `aria-labels`, missing image `alt` tags, duplicate IDs, legal color contrast ratios (e.g., WCAG AA), and keyboard focus states.
4. **Runtime & Network States:** It actively fails validation if your component throws a JavaScript Console Error or if a network request (like fetching a font) fails. It can also simulate browser interactions like `:hover`, `:focus`, and `:active`.

This deep evaluation gives your AI model the exact pinpoint data it needs to write the perfect CSS patch without hallucinating!

---

## 📍 How does it know where your component is?

You might wonder: _How does the AI know where to navigate in the browser or which file to edit?_

It uses a powerful mix of **auto-discovery** and **strict user boundaries**:

1. **The Browser Route (User Tells):** When triggering the validation loop, you explicitly tell the Validator where to look by passing your local dev server URL (e.g., `--route http://127.0.0.1:4173/nav`).
2. **Code Auto-Discovery (It Infers):** Before making edits, the Validator runs an internal `inspect` mechanism on your repository. It automatically discovers if you use React or Angular, infers where your components live, extracts your design tokens/CSS variables, and maps your Storybook routing conventions.
3. **File Boundaries (User Limits):** Even though it understands your entire codebase, you must explicitly allowlist the files it is allowed to touch via your `smart-ui.config.json` (e.g., `"allowedPaths": ["src/components/"]`). It will never blindly guess and edit random files outside this restricted sandbox.

---

## ✨ What to Expect

- **Bounded "Self-Healing" Repairs:** The AI can attempt to fix a component in a loop. If a patch lowers the visual score or breaks your unit tests, the Validator instantly rolls the file back. It bounds the AI to a maximum number of attempts (e.g., 5 passes).
- **Strict Sandbox Safety:** The AI is only allowed to edit explicitly allowed files. It cannot execute arbitrary shell commands or make unauthorized external network requests.
- **Governed Memory (It Learns):** If the AI figures out that your project uses a specific Tailwind class or CSS token, it will ask if it should remember that. The Validator saves confirmed preferences in a local SQLite database and automatically injects them into future prompts so the AI doesn't make the same mistakes twice.

---

## 🛠️ Requirements

Before starting, you need:

- **Node.js** (v22.16 or newer)
- **pnpm** (v10.15.0, only when building this repository from source)
- **Playwright Chromium** (provisioned and launch-tested by `smart-ui setup`)
- **An MCP-Compatible AI Host** (e.g., Claude Code, GitHub Copilot, or Codex)

---

## 🚀 Getting Started (Setup)

### Generate standalone HTML from an SVG

SVG generation is repository-free and does not require Figma, MCP, a model, a target application, or
external network access. It produces immutable evidence and a reproducible ZIP; `--output` is
optional and must name a new empty directory inside the exact workspace.

```bash
npx smart-ui generate \
  --workspace /absolute/path/to/svg-workspace \
  --design /absolute/path/to/svg-workspace/design/hero.svg \
  --output /absolute/path/to/svg-workspace/generated/hero \
  --mode hybrid \
  --layout responsive
```

Use `--mode exact` for artwork-heavy SVGs or `--mode semantic` for the strongest bounded semantic
projection. `--dry-run --json` performs strict safety and capability
inspection without writing an HTML/CSS deliverable. Generated pages use local files only and are
rendered on a contained loopback preview with browser networking blocked before Smart UI reports
source-viewport visual fidelity. A configured narrow viewport is reported separately as responsive
robustness, never as fidelity to the desktop SVG.

Connected MCP hosts use the same engine: `inspect_svg` returns compact capabilities and a paged
context handle; `generate_html_from_svg` accepts an optional user-approved host file proposal;
`get_generation` and `get_generation_report` retrieve bounded results; and `export_generation`
requires a separate approval for the accepted manifest hash, every relative path, and one exact new
empty destination. Read `smart-ui://svg-generation-guide` before this workflow. The host never
scores its own proposal or gains a generic writer/browser/shell tool.

### 1. Install from npm (recommended)

Install the CLI in the React or Angular project that Smart UI will validate, then run the supported
first-time setup command:

```bash
npm install --save-dev smart-ui-validator@0.4.2
npx smart-ui setup --target . --agent-memory
npx smart-ui doctor --target .
```

`setup` installs the Chromium revision pinned by this Smart UI release using the package-local
Playwright installer; it never relies on a global Playwright version. It then launches a disposable
browser page to prove the executable works. `--agent-memory` additionally performs a disposable
write, close, reopen, read, and delete canary against embedded SQLite. It does not require SQL
Server, PostgreSQL, or a separately installed SQLite service.

Agent Memory is optional and disabled by default. Omit `--agent-memory` when you do not intend to use
the Agent Memory backend. If `memory.enabled` is true and `memory.backend` is `agent-memory` in the
project configuration, setup checks it automatically.

For automation and support bundles, use `--json`:

```bash
npx smart-ui setup --target . --agent-memory --json
```

The command exits with code `4` when installation, the browser launch canary, target inspection,
strict configuration, or an enabled Agent Memory canary fails.

### 2. Build the Engine from source

Contributors can clone and build the complete workspace:

```bash
git clone <public-repository-url>
cd smart-ui-validator
pnpm install --frozen-lockfile
pnpm build
pnpm smart-ui setup --target fixtures/react-app
```

The repository root is not itself a React or Angular target, so setup points at the React fixture.

### 3. Wire up your AI Host

Because the Validator is an MCP server, you must connect your AI to it.

**For Claude Code (Terminal):**
Create a `.mcp.json` file in your target project (where you want Claude to work):

```json
{
  "mcpServers": {
    "smart-ui": {
      "command": "npx",
      "args": ["-y", "smart-ui-validator-mcp@0.4.2"],
      "cwd": "/absolute/path/to/your/project",
      "env": {
        "SMART_UI_MCP_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

_(For VS Code Copilot or Codex, see the [Host Setup Guide](docs/hosts.md) for configuration examples)._

### Faster first run: generate the workflow once

Instead of manually copying design evidence, choosing artifact paths, and restating arguments to the
agent, run:

```bash
pnpm workflow:setup -- \
  --target /absolute/path/to/your/project \
  --design /absolute/path/to/reference.svg \
  --url http://127.0.0.1:4200/ \
  --component LoginComponent \
  --host codex \
  --ensure-engine
```

This produces a target-contained `.smart-ui/workflow.json`, exact agent instructions, and a host
configuration snippet. After connecting or restarting the host once, ask the agent to call
`prepare_workflow` with the manifest. It will inspect and normalize once, then reuse the returned
compact validation arguments. See the [agent-first workflow](docs/agent-workflow.md) for the full
state machine, retry limits, and recovery rules.

### 4. Set the Rules (The Sandbox)

Create a `smart-ui.config.json` in the root of your target project. This tells the Validator what the AI is allowed to do.

```json
{
  "schemaVersion": "1.0",
  "validation": {
    "maxRepairPasses": 5,
    "colorDeltaE": 2.5
  },
  "generation": {
    "artifactBase": ".smart-ui/generations",
    "timeoutMs": 60000,
    "maxPasses": 1,
    "maxProposalRegressionPercent": 0
  },
  "policy": {
    "allowedPaths": ["src/components/", "src/styles.css"],
    "allowedCommands": [{ "executable": "pnpm", "args": ["test"] }]
  }
}
```

---

## 💻 The Developer Workflow (In Action)

Once everything is wired up, here is what your day-to-day workflow looks like:

### 1. Ingest the Design

When your designer hands you a Figma spec or reference image, you normalize it into a machine-readable `DesignContract`:

```bash
pnpm smart-ui design normalize --image ./design-specs/reference.svg --out /tmp/design.json
```

### 2. Prompt your AI

Open your IDE or terminal, boot up your local dev server (e.g., `http://localhost:4173`), and ask your AI:

> _"Build the Navigation component based on this design contract. Use the Smart UI tools to validate and fix it against `http://localhost:4173/nav` until the visual score is above 95/100."_

### 3. The Validator Takes Over

- **Validation:** The AI writes the initial code and calls the Validator. The Validator launches
  headless Chromium, captures the DOM, and returns representative findings with the target DOM
  locator, expected value, actual value, delta, confidence, and repair category.
- **Focused retrieval:** When a run has more findings than fit in the compact response, the AI calls
  `get_findings` to page by category or severity without repeating screenshots or other binary
  evidence.
- **The Repair Loop:** After you approve the exact files, the AI submits a full-file
  `proposedChanges` batch. The Validator applies that batch once through its exact write policy,
  runs configured checks, and takes another Chromium screenshot. Calls without `proposedChanges`
  use only the deliberately narrow background-color fallback.
- **Rollbacks:** If the AI accidentally breaks the layout or fails a test, the Validator cleanly rolls the file back to the previous state.

Each validation pass records both the binary check score and proportional visual mismatch. A patch
can therefore be retained when it measurably improves the raster before crossing the final pass
threshold, but it is rejected if the structural score or visual result regresses.

> **Reference-image note:** A PNG, JPEG, or SVG without a semantic sidecar provides raster evidence
> only. Supply a structural spec or Figma element evidence when you need deterministic statements
> such as “padding is 16px but should be 24px.”

### 4. Confirming Memory (Learning)

When the component is finished, the AI might realize you prefer using CSS variables (e.g., `--spacing-4`). The Validator will ask you in the terminal or chat:

> _"Should I remember to map 16px to `--spacing-4` for this repository?"_

If you say yes, this preference is saved to `.smart-ui/agent-memory.sqlite`. The next time you ask the AI to build a component, it will automatically use `--spacing-4` on its very first try.

---

## 🚨 Troubleshooting & Exit Codes

If you are using the CLI manually, pay attention to the exit codes:

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Success. No blocking validation findings remain.                         |
| `1`  | Unexpected command/runtime failure.                                      |
| `2`  | Invalid user input or strict schema/config error.                        |
| `3`  | Validation completed, but blocking visual/accessibility findings remain. |
| `4`  | An operation failed or the target environment is untrustworthy.          |

**Common Issues:**

- **Chromium missing or cannot launch:** Run `smart-ui setup --target <project>`. For a local npm
  installation, use `npx smart-ui setup --target <project>`.
- **Agent Memory fails:** No system database server is required. Confirm Node 22.16+, then run
  `smart-ui setup --target <project> --agent-memory`. Without that backend, keep memory disabled or
  use the default local JSON memory store.
- **Install succeeds but setup fails:** This is expected when a runtime asset is unavailable. npm
  installs JavaScript packages only; Smart UI intentionally avoids a large, network-dependent
  Chromium `postinstall` download.
- **Write rejected:** Ensure the file you want the AI to edit is explicitly listed in `smart-ui.config.json` under `allowedPaths`.
- **Command rejected:** Ensure your `allowedCommands` (like `pnpm test`) match exactly what the AI is trying to execute.
- **MCP path rejected:** Ensure `SMART_UI_MCP_ROOT` is set strictly to your target project folder, not a home directory.

---

## ❓ Frequently Asked Questions

**Does the Validator have built-in Storybook?**
It does not contain its own proprietary Storybook engine, but it **natively auto-discovers your existing Storybook**. If you have `@storybook/react` installed, the AI will build components in a `.stories.tsx` file and validate them against your Storybook iframe URL (e.g., `http://localhost:6006`), completely isolating the component from your messy app logic!

**How does it validate a deeply nested component without the header/footer ruining the score?**
You add a simple data attribute to your component: `data-validation-id="pricing-card"`. When the Validator runs, it searches the DOM for that attribute and mathematically scopes the validation _strictly_ to that box and its children, completely ignoring the rest of the webpage.

**How does it handle complex states (e.g., a component that only appears after 3 clicks)?**
Smart UI Validator is a visual component tool, not an end-to-end user journey tool (like Cypress). It will not simulate complex multi-step clicks. Instead, you isolate the component (via Storybook) or force the state to render via a URL flag (e.g., `http://localhost:4173/form?step=3`). _Note: Simple CSS states like `:hover` and `:focus` are natively supported and triggered automatically._

**How does the AI implement programmatic elements (like Modals or Toasts)?**
Because a Toast isn't in the DOM on initial load, the AI uses a **"Sandbox Route"** pattern. It writes the `Toast.tsx` component, creates a temporary test route (e.g., `src/pages/sandbox.tsx`), forces the Toast to open on that route, and points the Validator there. Once validation passes, the AI deletes the temporary sandbox route and leaves the perfect component behind!

---

## 📚 Deep Dives & Enterprise Docs

For administrators, security audits, and advanced integrations, see the detailed documentation:

- [Architecture & Interfaces](docs/architecture.md)
- [MCP Server Details](docs/mcp.md)
- [Agent-first Workflow](docs/agent-workflow.md)
- [Host Integrations (Claude, Copilot, Codex)](docs/hosts.md)
- [Security & Sandboxing](docs/security.md)
- [Threat Model](docs/threat-model.md)
- [Governed Memory Details](docs/memory.md)
- [Enterprise & Operations (Backups, Audits, Retention)](docs/operations.md)
- [Evaluation & Release Process](docs/release.md)
- [Publishing to npm](docs/npm-publishing.md)
- [Windows EXE/Desktop Plan](docs/smart-ui-validator-exe-plan.md)
- [Local Development & Testing](docs/development.md)
- [The Authoritative Implementation Plan](docs/implementation-plan.md)
