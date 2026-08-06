# Smart UI Validator MCP server

The production entry point is `smart-ui-mcp` over stdio. The server intentionally does not expose a
generic shell tool. Mutating operations require explicit approval fields and remain constrained by
the same exact path, command, endpoint, pass, timeout, and evidence policies as the CLI.
