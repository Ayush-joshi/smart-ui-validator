# `smart-ui-validator-core`

Host-neutral Smart UI Validator engine for repository inspection, design normalization,
deterministic Playwright evidence, visual and structural comparison, bounded repair, reporting,
policy enforcement, and governed memory.

The core also exports the repository-free SVG/PNG generation engine: strict bounded intake,
hierarchical `DesignBundle`, deterministic exact/hybrid/semantic HTML generation, manifest-only
loopback preview, existing comparator integration, immutable `GenerationRecord`, offline reporting,
and reproducible ZIP/export providers. Persistent generation and existing-UI handoff tasks let the
CLI, MCP server, Studio, external agents, and humans share the same evidence, write boundaries,
immutable review attempts, and explicit acceptance lifecycle.

This is a library package. Most users should install `smart-ui-validator` for terminal use or
`smart-ui-validator-mcp` for Codex, Claude Code, VS Code, and other MCP hosts.

## Requirements

- Node.js 22.16 or newer.
- A Playwright Chromium revision compatible with the package's pinned Playwright dependency. CLI
  consumers should provision it with `smart-ui setup`.
- A target React or Angular repository with an explicit Smart UI policy for validation/repair, or a
  dedicated workspace boundary for SVG generation.

## API

```ts
import { AutoFrameworkAdapter, runDoctor, runSetup } from 'smart-ui-validator-core';

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

The public declarations define the supported API. Preserve the documented security boundaries when
embedding the engine in another host.

`HostProposedRepairProvider` bridges one already-approved host-agent patch batch into the bounded
repair coordinator. The coordinator records both binary check score and visual mismatch per pass;
it may retain raster convergence before the binary raster threshold passes, but it rejects check
score or measurable visual regressions.
