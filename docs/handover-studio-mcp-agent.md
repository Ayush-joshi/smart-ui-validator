# Handover: Studio generation powered by the MCP-connected agent

> Status (2026-08-11): **Implemented** and manually verified end-to-end. The MCP-bridged authoring
> loop, `list_studio_authoring_requests`/`submit_studio_authored_html` tools, `awaiting-agent`
> lifecycle, context-carrying paste prompt, and `authoringCanvasGuidance` scale anchoring are in the
> working tree. Automated gates have not been re-run yet (deferred by request until the
> confirm-then-improve loop lands — see [`confirm-then-improve-plan.md`](./confirm-then-improve-plan.md)).
> This document is retained as historical design context.

Audience: a fresh coding-agent chat in this repository. Read `AGENTS.md` and
`/memories/repo/setup-and-startup.md` first. This document describes in-progress, uncommitted work
and the exact remaining task.

## Goal (user's words, condensed)

Smart UI Studio's SVG→HTML generation must be **AI-agent-powered by default**. The agent that
authors the HTML must be **the chat agent connected to this repo's MCP server** (VS Code Copilot
chat with the `smart-ui` stdio server from `.vscode/mcp.json`) — **not** an external
OpenAI-compatible endpoint and not a spawned CLI agent. The Studio context textbox must feed
whatever the user types directly into the agent's authoring evidence. After implementation, the
user wants to test end-to-end by uploading an SVG in Studio.

## Why this direction exists

The built-in `DeterministicHtmlGenerationProvider` never invents markup. For SVGs with outlined
text (no `<text>` nodes) it falls back to wrapping the sanitized SVG in an HTML shell — the user
saw exactly that and rejected it. Real HTML must come from a model-backed author, validated by the
existing deterministic pipeline (render both in Chromium, compare, keep evidence).

## Current state — uncommitted changes already in the working tree

`git status` shows (all unstaged, nothing committed this session):

| Path                                                     | State                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/agent-html-author.ts`                 | new, **to be replaced**            | `AgentHtmlAuthor` calls an external OpenAI-compatible chat-completions endpoint (`SMART_UI_AGENT_URL/MODEL/API_KEY` env). The user explicitly does **not** want this path. Salvage the prompt-assembly logic (`userPrompt`, text-node extraction, truncation) into the new request payload; delete the fetch/endpoint parts.                                                                                        |
| `packages/core/src/generation-orchestrator.ts`           | modified, **keep**                 | Adds `proposalPolicy: 'non-regression' \| 'prefer-proposal'` to `GenerationOrchestratorDependencies`. `prefer-proposal` keeps any valid, non-repeated proposal while still recording honest comparison evidence. Studio agent runs use this.                                                                                                                                                                        |
| `packages/core/src/index.ts`                             | modified                           | Exports `agent-html-author.js`. Update to export whatever replaces it.                                                                                                                                                                                                                                                                                                                                              |
| `apps/studio/src/server.ts`                              | modified, **partially keep**       | Session response now reports `agent: { configured, model }`; `parsePreferences` accepts `engine: 'agent' \| 'deterministic'`; `generate()` branches on engine, inspects first, wraps agent files in `HostProposedHtmlGenerationProvider('studio-agent:<model>', files)` with deterministic `fallbackGenerator` and `prefer-proposal`. Keep the shape; replace the `AgentHtmlAuthor` call with the MCP bridge below. |
| `apps/studio/src/client.tsx`                             | modified, **keep with copy edits** | Engine radio group (AI agent default, deterministic secondary), agent-aware context textbox label/placeholder, `engine` in the generate POST, agent provenance in review. Update copy that mentions `SMART_UI_AGENT_URL` env config — agent availability now depends on the MCP bridge, not env vars.                                                                                                               |
| `apps/studio/src/studio.css`                             | modified, keep                     | Styles for the engine choice grid.                                                                                                                                                                                                                                                                                                                                                                                  |
| `.vscode/mcp.json`                                       | new, keep                          | Workspace MCP config: stdio server `smart-ui` → `apps/mcp-server/dist/index.js`, `SMART_UI_MCP_ROOT=${workspaceFolder}`.                                                                                                                                                                                                                                                                                            |
| `.smart-ui-mcp-runs/`, `tests/.mcp-svg-generate-LWMnUs/` | untracked leftovers                | Test debris from MCP tool trials this session. Safe to delete; do not commit.                                                                                                                                                                                                                                                                                                                                       |

The build was green after these edits (`pnpm build` passed; `pnpm test` not yet run against them).

## The task: an MCP-bridged authoring loop

MCP is agent→server pull; Studio cannot push work into a chat. Bridge with a file-based request
queue inside the Studio workspace, and two new MCP tools the connected agent uses to pick up and
answer authoring requests.

### Flow

1. User uploads an SVG in Studio, keeps the default **AI agent** engine, optionally types context.
2. Studio inspects the SVG (existing `LocalSvgStructureProvider`), then writes one authoring
   request file and sets the run phase to a new `awaiting-agent` state (extend the `StudioRun`
   phase union and the client phase labels).
3. The user (or an automation) tells the chat agent to check for Studio work. The agent calls
   `list_studio_authoring_requests`, reads the evidence, authors complete `index.html` +
   `styles.css` (offline, self-contained, CSP-compatible: no external URLs, no scripts), and calls
   `submit_studio_authored_html`.
4. Studio's `generate()` — which has been polling the queue with a bounded timeout — picks up the
   response, wraps the files in `HostProposedHtmlGenerationProvider`, and runs the existing
   pipeline: path/byte validation, active-content blocking, isolated Chromium render of source and
   proposal, deterministic comparison, `prefer-proposal` retention, report + ZIP.
5. On timeout (suggest 10 minutes, configurable) the run fails closed with a clear message offering
   the deterministic engine; do not silently fall back.

### Queue contract (new module in `packages/core`, e.g. `studio-agent-bridge.ts`)

- Directory: `<studio-workspace>/agent-queue/` with `requests/<runId>.json` and
  `responses/<runId>.json`. Atomic writes (write temp + rename). Single-writer per file.
- Request payload: run ID, design name, viewport, mode, layout, theme/locale, unavailable fonts,
  readable text nodes, **user context verbatim** (bounded 4 000 chars, already enforced), sanitized
  SVG (truncated to a bounded size), creation time, expiry time. Reuse the prompt-assembly logic
  from `agent-html-author.ts` — it already builds exactly this evidence.
- Response payload: run ID, array of `{ path, content }` limited to `index.html`, `styles.css`,
  `assets/*.svg` (UTF-8 text only — mirror `host-proposed-generation.ts` limits), authoring agent
  label for provenance.
- Both schemas validated with Zod on read and write; malformed or expired entries fail closed and
  are surfaced in the run error. Treat all content as untrusted input.

### New MCP tools (in `apps/mcp-server/src/server.ts`, follow existing tool patterns)

| Tool                             | Contract                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_studio_authoring_requests` | Read-only (`readOnlyHint: true`). Input: optional `studioWorkspace` absolute path (must resolve inside `SMART_UI_MCP_ROOT`). Returns compact pending requests; large SVG evidence paged the same way `generation-context` resources page. |
| `submit_studio_authored_html`    | Requires `approved: true` plus exact `runId`. Validates the response payload against the queue contract, writes the response file, returns the acceptance status. `openWorldHint: false`, not destructive.                                |

Register both in the stdio smoke script expectations (`scripts/check-mcp-stdio.mjs` asserts tool
counts — update `23`/`5` accordingly) and in `docs/mcp.md`.

### Containment decision (must decide before coding)

`SMART_UI_MCP_ROOT` is the repo checkout; a Studio workspace outside that root (for example a
`smart-ui-studio-workspace` directory in the user's home) cannot legally be touched by the MCP
server. Pick one:

- **Recommended:** run Studio with a workspace inside the repo, e.g.
  `--workspace <repo>\.studio-workspace`, and add `.studio-workspace/` to `.gitignore`. No policy
  changes needed.
- Alternative: add an explicit `SMART_UI_MCP_STUDIO_QUEUE` allowlisted root to the MCP server.
  More code, more policy surface; only do this if the user insists on the external workspace.

### Studio server/UI specifics

- `startStudioServer` drops `resolveAgentAuthorConfigFromEnv`; the session `agent` field becomes
  `{ configured: true, transport: 'mcp' }` — the agent engine is always offered, since availability
  now depends on a live chat picking up the request, not on env vars.
- `generate()` agent branch: inspect → write request → progress stage `agent` ("Waiting for the
  connected MCP agent…", include remaining time) → poll `responses/` (e.g. every 2 s) respecting
  `run.controller.signal` → on response, proceed exactly as the current code does with
  `HostProposedHtmlGenerationProvider` + `fallbackGenerator` + `prefer-proposal`.
- Cancel must delete the pending request file.
- Client: show the `awaiting-agent` phase with a copyable one-line prompt the user can paste into
  chat, e.g. "Check smart-ui Studio authoring requests and author the pending design." Update the
  engine-card copy (no more env-var text). Keep provenance display (`studio-agent:<label>`).

### What to delete

- The endpoint/fetch half of `agent-html-author.ts` and its `SMART_UI_AGENT_*` env parsing, plus
  the corresponding export in `packages/core/src/index.ts` and any UI/server copy referring to
  those env vars.

## Verification gates (repo working rules — all must pass before claiming done)

```powershell
nvm use 22.18.0          # shell may default to 20.17
pnpm format:check ; pnpm lint ; pnpm typecheck ; pnpm build
pnpm test                 # unit/integration, excludes e2e
pnpm test:studio
pnpm test:mcp:stdio       # update expected tool counts
pnpm test:e2e             # real Chromium
```

Add tests: queue write/read/expiry/malformed-payload (fail closed), MCP tool contract tests via the
in-memory transport pattern in `tests/mcp-server.test.ts`, Studio server `awaiting-agent` lifecycle

- cancel + timeout in `tests/studio-server.test.ts`.

## Runbook for the live test afterwards

```powershell
nvm use 22.18.0
pnpm build
node apps\cli\dist\index.js studio --workspace <repo>\.studio-workspace --init --port 4600
```

1. Open http://127.0.0.1:4600/, upload an SVG, keep the AI agent engine, add context, generate.
2. In the chat (this MCP-connected agent), call `list_studio_authoring_requests`, author the HTML,
   `submit_studio_authored_html`.
3. Studio completes the run; review the comparison evidence and report.

MCP server config already exists in `.vscode/mcp.json`; restart the server in VS Code after
rebuilding (`MCP: List Servers` → restart `smart-ui`).

## Constraints and cautions

- Follow `AGENTS.md` working rules: fail-closed validation, exact path allowlists, treat design
  text/DOM/user context as untrusted, no arbitrary shell, provenance on artifacts.
- Do not weaken `host-proposed-generation.ts` validation — the agent's files go through it
  unchanged.
- Do not commit or push; the user reviews first. Leave the two untracked debris directories out of
  any commit, or delete them.
- The user separately plans to compare this flow against an Opus-driven chat; keep everything
  host-neutral (no Copilot-specific assumptions in the queue contract).
