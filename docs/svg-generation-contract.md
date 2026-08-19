# SVG/PNG generation contracts

Standalone SVG/PNG generation is versioned independently from repository validation. `DesignContract` and
`RunRecord` keep their existing meanings.

`SvgGenerationInput` declares one exact workspace boundary, a contained regular SVG or an internally
normalized wrapper for a verified PNG reference, unique core-owned
artifact root, optional separately requested export root, exact/hybrid/semantic mode, fixed/
responsive/component intent, bounded instructions, optional `StructuredDesignContext` 1.0, optional
`PresentationSpec` 1.0, source viewport, rendering background, locale, theme, timeout, pass limit,
and dry-run state. It may additionally carry a bounded redacted UTF-8 source-context record and the
original PNG reference metadata. MCP internally assigns an opaque generation ID.

`DesignBundle` 2.0 contains original and sanitized hashes, sanitized-source artifact, deterministic
viewport/background/font policy, sanitization counts/decisions, a bounded hierarchical scene with
stable node IDs, repeated values, layout and semantic candidates, unsupported constructs,
uncertainties, the validated structured context and its SHA-256 hash, explicit presentation intent,
and provenance. The compatibility reader upgrades supported 1.0 bundles by mapping instructions to
general notes and source dimensions to intrinsic presentation; unsupported versions fail closed.
SVG/XML and embedded image bodies remain content-addressed artifacts.
The MCP generation-context resource exposes at most 50 compact nodes per cursor and omits attributes,
raw XML, and binary data.

`GeneratedHtmlBundle` is an in-memory exact manifest. Each canonical unique relative path has a media
type, bytes, rationale, and source-node IDs. The public output contract permits `index.html`,
`styles.css`, and approved files under `assets/`; MCP host proposals accept UTF-8 HTML, CSS, and SVG
only. Core validation rejects traversal, devices, case collisions, excessive counts/bytes,
undeclared local references, active content, remote schemes/resources, and malformed CSS.

`GenerationRecord` 2.0 retains the accepted manifest hash, generated file hashes/artifacts,
sanitized source and design-bundle artifacts, mode/layout/rendering inputs, decisions,
uncertainties, viewport classification, immutable pass evidence, report/ZIP/visual artifacts,
timings, warnings/failures/cancellation, optional original PNG and redacted source-context artifacts,
their original hashes and redaction status, and optional host/proposal provenance. Proposal passes state
whether they were accepted or reverted. Source fidelity has similarity/mismatch metrics; responsive
robustness without a matching reference has findings and no fidelity score.

`PresentationSpec` separates the immutable source viewport from target presentation. Its primary
canvas has a stable ID, exact width, height, and DPR; fit is `intrinsic`, `contain`, `cover`, or
`stretch`; alignment is explicit; and the named viewport matrix is bounded by count and aggregate
rendered pixels. Phase 1 records named viewports but retains the existing single narrow robustness
evaluation; ordered multi-viewport fidelity/robustness evaluation is Phase 2 of the deferred plan.

`StructuredDesignContext` has bounded exact-copy, design-token, component-semantic, interaction, and
general-note fields with provenance. Duplicate stable identifiers, field/array/total-character budget
violations, and unsupported versions fail validation. Authoring requests are schema 3.0 and record
the original validated hash; common credential patterns may be redacted from the request with
`contextRedacted: true`. Supported authoring-request 1.0 files upgrade to intrinsic presentation and
general notes deterministically.

The manifest hash is a deterministic SHA-256 over sorted relative path, media type, and content hash.
`export_generation` must present that exact hash and the complete accepted relative-path set before
the reproducible exporter writes a new empty contained directory.

The CLI, stdio MCP adapter, and local Studio all call the public `GenerationOrchestrator` and persist
this contract. Studio adds `smart-ui-studio` provenance and a bounded per-run recovery pointer, but
the core `GenerationRecord` remains authoritative and no Studio-only output schema is introduced.
For CLI compatibility, `--design-context` recognizes legacy typed-context JSON; new callers should
use `--structured-context` for typed JSON and reserve `--design-context` for JSX/TSX or other UTF-8
source evidence.

CLI agent authoring uses a persistent `GenerationTask`: `smart-ui generation prepare` pins sanitized
SVG or verified PNG evidence, optional redacted source context, typed context, and canvas guidance.
An external author writes only the task proposal directory; a connected agent uses task-backed MCP
tools. `generation review` creates an immutable attempt and runs the host proposal against the
deterministic fallback. Acceptance is a separate revision-checked metadata decision. The legacy
`smart-ui generate --engine agent` and `--agent-timeout` queue/wait path is removed; Studio alone
retains its named queue tools as compatibility adapters during migration.
