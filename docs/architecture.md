# Architecture

The core is host-neutral: CLI, MCP, editor, and automation hosts translate inputs and outputs without
owning orchestration logic. `SmartUiOrchestrator` coordinates narrow interfaces:

- `DesignProvider` normalizes evidence into a `DesignContract`.
- `FrameworkAdapter` inspects a repository without mutation.
- `RepairProvider` receives compact deterministic findings and proposes bounded file changes.
- `CodingProvider` remains as a Phase 1-compatible host boundary; Phase 2 orchestration does not
  depend on a particular model.
- `BrowserProvider` captures deterministic implementation evidence.
- `SmartUiComparator` owns geometry, typography, appearance, asset, raster, runtime, and basic
  accessibility scoring.
- `ArtifactStore` persists content-addressed bytes and a manifest.
- `PolicyProvider` enforces paths, writes, commands, dry-run, and time limits.
- `Reporter` turns a `RunRecord` into a human-readable artifact.

Data flows from untrusted design and repository inputs through strict schemas and policy boundaries,
into an isolated browser and content-addressed evidence store. Repair proposals are checked against
exact writable files, command argument arrays, and endpoint allowlists. Each accepted patch is
re-rendered; non-improving, repeated, or test-regressing patches are reverted without overwriting
pre-existing content. Run records contain artifact references, never binary prompt data. Packages
remain deliberately limited to `core`, `cli`, and a fixture until more boundaries are justified.
