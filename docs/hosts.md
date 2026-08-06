# Host setup

All hosts call the same MCP schemas; none owns or forks core orchestration.

## Codex CLI, app, and IDE

Copy `examples/hosts/codex/.codex/config.toml` into a trusted target repository and replace both
absolute paths. Build Smart UI first. The ChatGPT desktop app, Codex CLI, and Codex IDE extension
share MCP configuration. Restart the client, run `codex mcp list` or open `/mcp`, and verify all 13
tools. Keep the default approval mode at `writes` and explicit prompts for repair and memory mutation.

Copy the relevant content from `AGENTS.example.md` into the target's existing `AGENTS.md`; merge it
with repository instructions rather than replacing them.

## Claude Code

Copy the sample `.mcp.json`, set `SMART_UI_VALIDATOR_ROOT`, start Claude Code from the target, review
the project-server trust prompt, and inspect `/mcp` or `claude mcp list`. Project scope is appropriate
for a shared, credential-free stdio definition. Keep machine credentials out of `.mcp.json`.

The sample sets `SMART_UI_MCP_ROOT` to Claude's project directory. If your host does not expose that
variable, replace it with the one absolute target repository path before trusting the server.

## VS Code and GitHub Copilot

Copy `.vscode/mcp.json`, start the MCP server from the workspace command palette, enter the trusted
absolute Smart UI checkout path, and review the trust prompt. The sample enables sandboxing, limits
writes to the workspace, and limits networking to loopback. Sandboxing availability varies by host
platform; when unavailable, rely on Smart UI's exact policy plus OS/container controls.

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
