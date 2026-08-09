# Smart UI Validator MCP server

The production entry point is `smart-ui-mcp` over stdio. The server intentionally does not expose a
generic shell tool. Mutating operations require explicit approval fields and remain constrained by
the same exact path, command, endpoint, pass, timeout, and evidence policies as the CLI.

## Requirements

- Node.js 22.16 or newer.
- Playwright Chromium compatible with the package's pinned Playwright version.
- One exact trusted target workspace root.

## Usage

An MCP host can start the published server with:

```text
command: npx
args: -y smart-ui-validator-mcp@0.4.1
cwd: <absolute-target-project>
```

Production desktop builds do not use `npx`; they bundle the exact package and a private Node runtime.

The server publishes capabilities, a workflow guide, run resources, the `implement-and-validate`
prompt, and approval-annotated tools. Set `SMART_UI_MCP_ROOT` when the host cannot supply the exact
target as `cwd`. Never set the root to a drive, home directory, or another broad shared path.

The package documentation covers host configuration, tool schemas, workflow setup, and security
guidance without requiring personal repository metadata.
