# Design contract

`DesignContract` is the versioned, framework-neutral representation of current design evidence.
Phase 2 retains schema version `1.0` and validates it at runtime with strict Zod schemas.

```json
{
  "schemaVersion": "1.0",
  "id": "generated UUID",
  "name": "FixtureCard",
  "viewport": { "width": 800, "height": 600, "deviceScaleFactor": 1 },
  "theme": "light",
  "locale": "en-US",
  "component": { "name": "FixtureCard", "route": "/" },
  "reference": {
    "hash": "sha256:…",
    "mediaType": "image/svg+xml",
    "relativePath": "objects/ab/….svg",
    "byteLength": 1234
  },
  "provenance": {
    "provider": "local-image",
    "source": "/reference.svg",
    "capturedAt": "2026-01-01T00:00:00.000Z",
    "sourceHash": "sha256:…"
  },
  "ambiguities": [],
  "elements": [
    {
      "validationId": "card-title",
      "type": "text",
      "x": 40,
      "y": 48,
      "width": 220,
      "height": 32,
      "fontFamily": "Arial",
      "fontSize": 24,
      "color": "#111827",
      "accessibleName": "Validated interface"
    }
  ],
  "sourceEvidence": {
    "assets": [],
    "uncertainties": []
  }
}
```

Additive fields may be introduced within a major version. Breaking semantic or required-field changes
require a new version and explicit migration. Current pinned evidence and explicit instructions outrank
any future remembered preference. Local images without a semantic sidecar explicitly record that
geometry, typography, assets, and accessibility could not be inferred. Figma contracts retain layout
context, variables, Code Connect maps, and fetched assets as hash-addressed evidence when available;
they do not fabricate unavailable measurements.
