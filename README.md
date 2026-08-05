# Smart UI Validator

Smart UI Validator is a host-neutral UI engineering engine and CLI. Phase 1 can inspect a React
repository, normalize a local reference image into a versioned design contract, capture a running
fixture in an isolated Playwright browser, store evidence by content hash, and emit a structured run
record plus an HTML report.

It does **not** yet compare pixels, repair visual differences, connect to Figma, support Angular, or
learn preferences. Those capabilities belong to later phases.

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

Start the fixture with `pnpm fixture:dev --port 4173`, then run:

```bash
pnpm smart-ui run --target fixtures/react-app \
  --design /tmp/smart-ui-design.json --route http://127.0.0.1:4173 \
  --artifacts /tmp/smart-ui-artifacts --dry-run --json
pnpm smart-ui report /path/to/run-record.json --format html
```

Generated artifacts are excluded from Git by default. See [development](docs/development.md),
[architecture](docs/architecture.md), and [security](docs/security.md).
