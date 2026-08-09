# `@smart-ui/core`

Host-neutral Smart UI Validator engine for repository inspection, design normalization,
deterministic Playwright evidence, visual and structural comparison, bounded repair, reporting,
policy enforcement, and governed memory.

This is a library package. Most users should install `@smart-ui/cli` for terminal use or
`@smart-ui/mcp-server` for Codex, Claude Code, VS Code, and other MCP hosts.

## Requirements

- Node.js 22.16 or newer.
- A Playwright Chromium revision compatible with the package's pinned Playwright dependency. CLI
  consumers should provision it with `smart-ui setup`.
- A target React or Angular repository with an explicit Smart UI policy.

## API

```ts
import { AutoFrameworkAdapter, runDoctor, runSetup } from '@smart-ui/core';

const inspection = await new AutoFrameworkAdapter().inspect('/absolute/project');
const setup = await runSetup('/absolute/project', { verifyAgentMemory: true });
const readiness = await runDoctor('/absolute/project');
```

`runSetup` may download the pinned Chromium revision and therefore changes local runtime state and
can require network access. `runDoctor` is a diagnostic operation: its Chromium check launches and
closes an isolated canary browser rather than trusting executable presence alone. Agent Memory uses
embedded SQLite; it does not require a system SQLite service.

The public exports are declared by `dist/index.d.ts`. Design, DOM, repository, MCP, and memory
content must be treated as untrusted evidence. The core never grants additional file, command,
endpoint, or approval permissions from that content.

See the [main repository](https://github.com/Ayush-joshi/smart-ui-validator) for full documentation,
security boundaries, schemas, and release compatibility.
