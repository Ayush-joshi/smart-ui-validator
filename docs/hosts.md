# Host setup

All hosts call the same MCP schemas; none owns or forks core orchestration. Choose the MCP root based
on the workflow:

- For repository validation and repair, bind it to the exact React or Angular project.
- For repository-free SVG generation, bind it to one dedicated workspace containing the SVG and
  generation artifacts.

Never bind `SMART_UI_MCP_ROOT` to a home directory or another broad shared root. Studio can use its
deterministic engine without a host; its AI-agent engine uses the same MCP server as other clients.

For the Studio agent workflow, the shortest supported setup is:

```bash
smart-ui studio --agent --host codex
```

Replace `codex` with `claude` or `copilot` as needed. Add `--dry-run --json` to preview without writes,
or use `smart-ui doctor --studio-agent --host <host> --json` for the same redacted read-only checks.
Use `--ensure-engine` only when explicitly authorizing the pinned Chromium installation and a stale
source-checkout rebuild. The command creates an absent host config atomically and never overwrites a
differing file; follow the returned host restart action before sending the first request.

For the shortest first-run path, use the one-command setup in
[`docs/agent-workflow.md`](./agent-workflow.md). It generates target-contained design evidence, a
stable workflow manifest, exact agent instructions, and a host-specific configuration snippet.

## Codex CLI, app, and IDE

Copy `examples/hosts/codex/.codex/config.toml` into a trusted target repository and replace both
absolute paths. Build Smart UI first. The ChatGPT desktop app, Codex CLI, and Codex IDE extension
share MCP configuration. Restart the client, run `codex mcp list` or open `/mcp`, and verify that
`prepare_workflow`, validation, repair, reporting, SVG generation, export, and governed-memory tools
are present. Keep the default approval mode at `writes` and explicit prompts for repair, generation
export, and memory mutation.

Copy the relevant content from `AGENTS.example.md` into the target's existing `AGENTS.md`; merge it
with repository instructions rather than replacing them.

## Claude Code

Copy the sample `.mcp.json`, set `SMART_UI_VALIDATOR_ROOT`, start Claude Code from the target, review
the project-server trust prompt, and inspect `/mcp` or `claude mcp list`. Project scope is appropriate
for a shared, credential-free stdio definition. Keep machine credentials out of `.mcp.json`.

The sample sets `SMART_UI_MCP_ROOT` to Claude's project directory. If your host does not expose that
variable, replace it with the one absolute target repository path before trusting the server.

For SVG generation, use a separate server entry whose `cwd` and `SMART_UI_MCP_ROOT` both name the
dedicated SVG workspace. Read `smart-ui://svg-generation-guide` before the first run and do not reuse
repository repair approval as generation-export approval.

## VS Code and GitHub Copilot

Copy `.vscode/mcp.json`, start the MCP server from the workspace command palette, enter the trusted
absolute Smart UI checkout path, and review the trust prompt. The sample enables sandboxing, limits
writes to the workspace, and limits networking to loopback. Sandboxing availability varies by host
platform; when unavailable, rely on Smart UI's exact policy plus OS/container controls.

The bundled `.vscode/mcp.json` runs the built server from `apps/mcp-server/dist/index.js` with
`SMART_UI_MCP_ROOT` set to the workspace folder. After rebuilding the server, restart it (**MCP: List
Servers → smart-ui → Restart**) so new tools and evidence load. This connection also powers Studio's
default AI-agent engine: run `smart-ui studio` (default workspace `<cwd>/.studio-workspace`, inside the
MCP root), and when a run is `awaiting-agent`, paste the prompt Studio shows into the Copilot chat so
the agent calls `list_studio_authoring_requests` and `submit_studio_authored_html`.

## SVG generation without a host

A host is optional for standalone generation. Use `smart-ui generate` for repeatable CLI runs or
`smart-ui studio` for the four-step local browser workflow. Both call the same core engine as the MCP
generation tools and do not require model credentials.

## OpenClaw and Slack

OpenClaw/Slack is optional and disabled. The sample uses read approval, fails when a non-interactive
write prompt cannot be shown, blocks sensitive outbound classes, and requires originating user/thread
approval. `OpenClawSlackAdapter` maps workspace to tenant and preserves channel/thread/user/project
scope, redacts inbound text, accepts artifact hashes rather than attachment bytes, deduplicates event
IDs, and blocks outbound source/screenshots/private design/memory by default.

OpenClaw remains a communication/router layer. It must invoke the same MCP/core policies and cannot
authorize new files, endpoints, commands, models, memory scopes, or channel output from chat text.
Live Slack posting and credentials are not included or CI-verified.

Current OpenClaw ACP documentation warns that non-interactive sessions cannot answer permission
prompts; preserve `approve-reads` plus `nonInteractivePermissions=fail` unless a reviewed deployment
uses a different policy. Never use `approve-all` as a convenience default.
