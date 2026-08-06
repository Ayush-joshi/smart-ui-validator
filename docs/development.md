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
pnpm evaluate
pnpm security:secrets
pnpm package:check
pnpm audit --prod --audit-level high
pnpm sbom
```

The end-to-end suite starts Vite on `127.0.0.1:4173` and Angular on `127.0.0.1:4273`, normalizes the
owned checked-in references, captures Chromium at desktop/mobile and focus state, localizes
intentional mismatches, and checks evidence repeatability. Locale, timezone, color scheme, reduced
motion, animations, viewport, clock, and fixture data are fixed. Arial avoids downloading fonts.
Use `pnpm fixture:dev` or `pnpm fixture:angular:dev` for manual CLI testing.

## Repository configuration

`smart-ui.config.json` is optional and strictly validated. Unknown keys and unsafe values fail the
run. Commands are disabled until both the command and its exact
executable/argument tuple are allowlisted.

```json
{
  "schemaVersion": "1.0",
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
    "requireAccessibleNames": true,
    "minimumContrastRatio": 4.5,
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
  "states": [{ "name": "default" }],
  "masks": [{ "x": 0, "y": 0, "width": 100, "height": 24 }],
  "dynamicRegions": []
}
```

The CLI validates one pinned contract or schedules the configured viewports/states with
`validate-matrix`. See the README for the complete memory/enterprise defaults and operator workflow.
