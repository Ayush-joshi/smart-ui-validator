# MCP server

`@smart-ui/mcp-server` exposes the host-neutral core over MCP stdio. Stdio is the only enabled
transport in 0.4.0. Streamable HTTP must not be enabled until a deployment supplies authenticated
tenant/user identity, authorization, TLS, request limits, audit correlation, and secure token
handling.

The server publishes `smart-ui://capabilities`, a run resource template, and the
`implement-and-validate` prompt. Tools use strict Zod-derived JSON schemas and accurate
`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` annotations. Read-like tools
do not modify a target; validation and normalization can create artifacts; repair and governed memory
mutation require explicit approval fields. No generic shell or arbitrary command tool exists.

Every filesystem input is contained within the server process working directory. Set
`SMART_UI_MCP_ROOT` to one absolute trusted workspace root when the host cannot set `cwd`; paths
outside that root fail closed. Do not set it to a home directory or another broad shared path.

Long operations pass MCP cancellation signals into the bounded core. Completed calls return compact
structured content, a deterministic terminal run record, and artifact references. `answer_question`
and `continue_run` provide process-local answer handoff only; durable queues and automatic
cross-process run resumption remain host/deployment responsibilities and capability discovery says
so explicitly.

Build and configure hosts with the absolute `apps/mcp-server/dist/index.js` path. Contract tests use
the official SDK's linked in-memory transports to list tools/resources/prompts and invoke the same
Angular inspection tool used by all hosts.

Official references:

- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
