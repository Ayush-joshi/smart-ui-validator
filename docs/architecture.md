# Architecture

The core is host-neutral: CLI, MCP, editor, and automation hosts translate inputs and outputs without
owning orchestration logic. `SmartUiOrchestrator` coordinates narrow interfaces:

- `DesignProvider` normalizes evidence into a `DesignContract`.
- `FrameworkAdapter` inspects a repository without mutation. `AutoFrameworkAdapter` selects the
  production React or Angular adapter from package evidence; both discover components, tokens,
  routes, states, tests, Storybook, and native conventions within strict file/byte budgets.
- `RepairProvider` receives compact deterministic findings and proposes bounded file changes.
- `CodingProvider` remains as a Phase 1-compatible host boundary; Phase 2 orchestration does not
  depend on a particular model.
- `BrowserProvider` captures deterministic implementation evidence.
- `SmartUiComparator` owns geometry, typography, appearance, asset, raster, runtime, and basic
  accessibility scoring.
- `ArtifactStore` persists content-addressed bytes and a manifest.
- `PolicyProvider` enforces paths, writes, commands, dry-run, and time limits.
- `Reporter` turns a `RunRecord` into a human-readable artifact.
- `InteractionProvider` asks bounded host-neutral questions; terminal and non-interactive hosts own
  presentation and timeout behavior.
- `MemoryProvider` owns scoped lifecycle operations. `LocalMemoryProvider` is deterministic storage;
  `AgentMemoryProvider` uses the linked fork's public `VectorStore` for SQLite persistence and
  rehydrates governed records without importing fork internals.
- `AuthorizationProvider`, `EncryptionProvider`, `MetricsProvider`, `FileAuditLog`,
  `LocalBackupManager`, and `RetentionManager` define deployment control boundaries without coupling
  orchestration to one identity, KMS, telemetry, or storage vendor.
- `LocalBaselineStore` keeps explicit, attributed visual-regression approvals.
- `@smart-ui/mcp-server` is a thin stdio adapter. Codex, Claude Code, Copilot, and optional
  OpenClaw/Slack use the same core and schemas.

Data flows from untrusted design and repository inputs through strict schemas and policy boundaries,
into an isolated browser and content-addressed evidence store. Repair proposals are checked against
exact writable files, command argument arrays, and endpoint allowlists. Each accepted patch is
re-rendered; non-improving, repeated, or test-regressing patches are reverted without overwriting
pre-existing content. Run records contain artifact references, never binary prompt data. Package
boundaries remain limited to the host-neutral core, CLI, and stable MCP distribution surface.

Memory recall occurs after repository inspection and before design comparison. It is optional,
identity-bound, scope-filtered, budgeted, marked as untrusted/advisory, and recorded as a compact
decision containing identifiers and context measurements. It never reaches `PolicyProvider` and
cannot expand paths, commands, endpoints, or approvals.

Browser state setup occurs after deterministic page settling and before DOM/screenshot capture.
Hover/focus/active use an explicit selector; loading/empty/error/disabled are route-owned rendered
states. Elements marked dynamic must match configured selectors; their measured rectangles join
the deterministic raster mask list. Accessibility violations and contrast remain code-calculated.

The workspace now contains `core`, `cli`, `mcp-server`, React and Angular fixtures. Remote HTTP and
channel networking are not core responsibilities and stay disabled until their deployment control
planes authenticate and authorize an explicit isolation context.
