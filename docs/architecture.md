# Architecture

The core is host-neutral: CLI, MCP, editor, and automation hosts translate inputs and outputs without
owning orchestration logic. `SmartUiOrchestrator` coordinates narrow interfaces:

- `DesignProvider` normalizes evidence into a `DesignContract`.
- `FrameworkAdapter` inspects a repository without mutation.
- `CodingProvider` proposes bounded file changes. Phase 1 ships only an explicit mock.
- `BrowserProvider` captures deterministic implementation evidence.
- `ArtifactStore` persists content-addressed bytes and a manifest.
- `PolicyProvider` enforces paths, writes, commands, dry-run, and time limits.
- `Reporter` turns a `RunRecord` into a human-readable artifact.

Data flows from untrusted design and repository inputs through validation and policy boundaries, into
an isolated browser and immutable evidence store. Run records contain references, never binary data.
Packages are deliberately limited to `core`, `cli`, and a fixture until more boundaries are justified.
