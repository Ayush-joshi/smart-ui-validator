# ADR 0001: Host-neutral core with adapters

Status: Accepted

## Decision

Keep orchestration and schemas independent of Codex, Claude Code, Copilot, OpenClaw, MCP, and any
single model. Integrations implement narrow provider interfaces and remain replaceable.

## Consequences

The same deterministic run can be invoked from a CLI or future MCP server, providers can be mocked,
and security policy is consistent. The tradeoff is explicit translation at adapter boundaries.
