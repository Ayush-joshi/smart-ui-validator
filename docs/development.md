# Development

## Quality gates

```bash
pnpm install
pnpm exec playwright install chromium
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
```

The end-to-end test starts Vite on `127.0.0.1:4173`, normalizes the checked-in reference, captures
Chromium at 800×600/DPR 1, writes temporary content-addressed artifacts, and verifies the dry-run
record and HTML report. Locale, timezone, color scheme, reduced motion, animations, viewport, and
fixture data are fixed. Arial avoids downloading fonts. Use `pnpm fixture:dev` for manual CLI testing.
