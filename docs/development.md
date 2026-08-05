# Development

Use Node.js 22.16 or newer and pnpm 10. The Agent Memory dependency establishes the Node runtime
floor; its SQLite-backed tests currently emit Node's experimental SQLite warning.

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

The end-to-end suite starts Vite on `127.0.0.1:4173`, normalizes the checked-in reference, captures
Chromium at desktop and mobile viewports, localizes intentional mismatches, and checks evidence
repeatability across identical runs. Locale, timezone, color scheme, reduced motion, animations,
viewport, clock, and fixture data are fixed. Arial avoids downloading fonts. Use `pnpm fixture:dev`
for manual CLI testing.

## Repository configuration

`smart-ui.config.json` is optional and strictly validated. Unknown keys and unsafe values fail the
run. These are the Phase 2 defaults; commands are disabled until both the command and its exact
executable/argument tuple are allowlisted.

```json
{
  "validation": {
    "geometryTolerancePx": 2,
    "typographyTolerancePx": 1,
    "colorDeltaE": 2.5,
    "visualDifferencePercent": 0.75,
    "rasterChannelTolerance": 10,
    "textWrapMismatchAllowed": false,
    "requireNoConsoleErrors": true,
    "requireNoNetworkFailures": true,
    "requireKeyboardNavigation": true,
    "maxRepairPasses": 5,
    "minimumScoreImprovement": 0.01
  },
  "evidence": {
    "maxElements": 2000,
    "maxTextLength": 4000,
    "maxConsoleMessages": 200,
    "maxFailedRequests": 200,
    "maxArtifactBytes": 20000000,
    "maxDiagnosticCharacters": 80000
  },
  "memory": {
    "enabled": false,
    "learningEnabled": false,
    "backend": "local",
    "storePath": ".smart-ui/memory.json",
    "agentMemoryDatabasePath": ".smart-ui/agent-memory.sqlite",
    "maxRecords": 12,
    "maxCharactersPerMemory": 800,
    "maxTotalCharacters": 6000,
    "telemetryEnabled": false,
    "remoteBackendEnabled": false
  },
  "policy": {
    "allowedPaths": ["src/styles.css"],
    "allowedCommands": [
      { "executable": "pnpm", "args": ["typecheck"] },
      { "executable": "pnpm", "args": ["test"] }
    ],
    "endpointAllowlist": ["http://127.0.0.1:4173"],
    "blockExternalNetwork": true
  },
  "commands": {
    "format": null,
    "typecheck": { "executable": "pnpm", "args": ["typecheck"] },
    "test": { "executable": "pnpm", "args": ["test"] }
  },
  "viewports": [
    { "name": "desktop", "width": 800, "height": 600, "deviceScaleFactor": 1 },
    { "name": "mobile", "width": 390, "height": 844, "deviceScaleFactor": 1 }
  ],
  "masks": [{ "x": 0, "y": 0, "width": 100, "height": 24 }]
}
```

The current CLI validates the viewport pinned in each design contract. The `viewports` list records
repository policy for hosts that schedule multiple contracts; the checked-in end-to-end suite covers
both desktop and mobile contracts.
