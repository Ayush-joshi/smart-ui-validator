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
args: -y smart-ui-validator-mcp@0.5.0
cwd: <absolute-target-project>
```

Production desktop builds do not use `npx`; they bundle the exact package and a private Node runtime.

The server publishes capabilities, validation and SVG-generation guides, paged run/generation
resources, `implement-and-validate` and `generate-from-svg` prompts, and approval-annotated tools.
Set `SMART_UI_MCP_ROOT` when the host cannot supply the exact
target as `cwd`. Never set the root to a drive, home directory, or another broad shared path.

Compact validation results retain representative DOM locators and expected/actual values.
`get_findings` provides filtered pagination when more evidence is needed. For general repairs, the
host agent supplies an explicitly approved full-file `proposedChanges` batch to `repair_component`;
the server applies it once, runs configured checks, revalidates in Chromium, and rolls it back when
it regresses. Calls without `proposedChanges` use the intentionally narrow background-color
fallback.

Repository-free SVG generation uses five additive tools: `inspect_svg`,
`generate_html_from_svg`, `get_generation`, `get_generation_report`, and `export_generation`.
Inspection and generation create only new core-owned per-run artifacts. An optional approved host
proposal is parsed and policy-checked, rendered with network blocked, measured by the core, and kept
only when it does not regress the deterministic fallback. Export is never implied by generation;
it requires the accepted manifest hash, the exact complete path list, an exact new empty destination,
and a separate approval.

Persistent generation and existing-UI implementation handoffs use `list_handoff_tasks`,
`get_handoff_task`, `read_handoff_evidence`, `submit_handoff_generation`, and
`submit_handoff_implementation`. Submissions require the exact task hash and revision plus explicit
approval, and create the same immutable deterministic review attempts as the CLI and Studio.

After `pnpm build`, `pnpm test:mcp:stdio` performs a real SDK stdio handshake against the built
server and verifies all five generation tools, the guide, the paged context resource, and the prompt.

The package documentation covers host configuration, tool schemas, workflow setup, and security
guidance without requiring personal repository metadata.
