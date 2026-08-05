# Smart UI Validator

Smart UI Validator is a host-neutral UI engineering engine and CLI. It normalizes local images
or Figma MCP evidence into a versioned design contract, captures a React target in an isolated
Playwright browser, deterministically compares structural and raster evidence, and applies bounded,
policy-controlled repairs. Every pass retains content-addressed screenshots, diffs, overlays,
findings, scores, patch rationale, and its terminal reason.

The shipped automatic repair provider is deliberately narrow: it demonstrates a controlled CSS
background-color repair. Broader production coding adapters, Angular, interaction-state validation,
and production framework adapters remain Phase 4 work. Phase 3 governed memory includes the local
provider, interaction contracts, lifecycle CLI, optional advisory recall, live Agent Memory SQLite
persistence, and safety tests. Figma and Chrome MCP adapters have recorded
contract tests; live MCP integration is opt-in and is not part of CI.

The linked Agent Memory fork is capability-checked through its installed public package. Smart UI
uses its public `VectorStore` for SQLite persistence while retaining lifecycle, consent, scope,
precedence, and recall-budget enforcement in the host-neutral governance layer.

## Quickstart

Requires Node.js 22.16+ and pnpm 10. Agent Memory and its public SQLite store establish this runtime
floor even when governed recall is disabled.

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
pnpm smart-ui --help
pnpm smart-ui inspect --target fixtures/react-app --json
pnpm smart-ui design normalize \
  --image fixtures/react-app/design/reference.svg \
  --spec fixtures/react-app/design/spec.json \
  --out /tmp/smart-ui-design.json \
  --artifacts /tmp/smart-ui-artifacts
```

Start the fixture with `pnpm fixture:dev --port 4173`, then run validation or a bounded repair:

```bash
pnpm smart-ui validate --target fixtures/react-app \
  --design /tmp/smart-ui-design.json --route http://127.0.0.1:4173 \
  --artifacts /tmp/smart-ui-artifacts --json
pnpm smart-ui fix --target fixtures/react-app \
  --design /tmp/smart-ui-design.json --route http://127.0.0.1:4173 \
  --artifacts /tmp/smart-ui-artifacts --allow-write src/styles.css \
  --max-passes 3 --dry-run --json
pnpm smart-ui compare target.png implementation.png --out diff.png --overlay overlay.png
pnpm smart-ui report /path/to/run-record.json --format html
```

Governed memory is disabled by default. Lifecycle commands require an explicit repository and bind
records to tenant/user identities:

```bash
pnpm smart-ui memory propose --target . --tenant local --user me \
  --scope repository:/absolute/repository/id --value "Prefer existing spacing tokens"
pnpm smart-ui memory list --target . --tenant local --user me --json
pnpm smart-ui memory confirm <id> --target . --tenant local --user me
pnpm smart-ui memory explain <id> --target . --tenant local --user me
pnpm smart-ui memory correct <id> --value "Prefer component spacing tokens" \
  --target . --tenant local --user me
pnpm smart-ui memory forget <id> --target . --tenant local --user me
```

Add `--backend agent-memory` to memory commands, or set `memory.backend` to `agent-memory` for
orchestrated runs. SQLite remains local and single-user; the local JSON governance record and Agent
Memory database are both stored under `.smart-ui/` by default.

Repository policy and thresholds are configured through `smart-ui.config.json`; defaults and an
example are in [development](docs/development.md). Generated artifacts are excluded from Git by
default. See the authoritative [implementation plan](docs/implementation-plan.md),
[architecture](docs/architecture.md), [design contract](docs/design-contract.md), and
[security](docs/security.md). Phase 3 scopes, lifecycle, consent, backup, and examples are in
[governed memory](docs/memory.md).
