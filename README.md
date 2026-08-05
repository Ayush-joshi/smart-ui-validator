# Smart UI Validator

Smart UI Validator is a host-neutral UI engineering engine and CLI. Phase 2 normalizes local images
or Figma MCP evidence into a versioned design contract, captures a React target in an isolated
Playwright browser, deterministically compares structural and raster evidence, and applies bounded,
policy-controlled repairs. Every pass retains content-addressed screenshots, diffs, overlays,
findings, scores, patch rationale, and its terminal reason.

The shipped automatic repair provider is deliberately narrow: it demonstrates a controlled CSS
background-color repair. Broader production coding adapters, Angular, interaction-state validation,
and governed preference learning remain Phase 3/4 work. Figma and Chrome MCP adapters have recorded
contract tests; live MCP integration is opt-in and is not part of CI.

## Quickstart

Requires Node.js 20+ and pnpm 10.

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

Repository policy and thresholds are configured through `smart-ui.config.json`; defaults and an
example are in [development](docs/development.md). Generated artifacts are excluded from Git by
default. See the authoritative [implementation plan](docs/implementation-plan.md),
[architecture](docs/architecture.md), [design contract](docs/design-contract.md), and
[security](docs/security.md).
