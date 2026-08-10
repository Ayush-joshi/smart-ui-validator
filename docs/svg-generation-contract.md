# SVG generation contracts

SVG generation is versioned independently from repository validation. `DesignContract` and
`RunRecord` keep their existing meanings.

`SvgGenerationInput` declares one exact workspace boundary, contained regular SVG, unique core-owned
artifact root, optional separately requested export root, exact/hybrid/semantic mode, fixed/
responsive/component intent, bounded instructions, source viewport, rendering background, locale,
theme, timeout, pass limit, and dry-run state. MCP internally assigns an opaque generation ID.

`DesignBundle` 1.0 contains original and sanitized hashes, sanitized-source artifact, deterministic
viewport/background/font policy, sanitization counts/decisions, a bounded hierarchical scene with
stable node IDs, repeated values, layout and semantic candidates, unsupported constructs,
uncertainties, and provenance. SVG/XML and embedded image bodies remain content-addressed artifacts.
The MCP generation-context resource exposes at most 50 compact nodes per cursor and omits attributes,
raw XML, and binary data.

`GeneratedHtmlBundle` is an in-memory exact manifest. Each canonical unique relative path has a media
type, bytes, rationale, and source-node IDs. The public output contract permits `index.html`,
`styles.css`, and approved files under `assets/`; Phase 2 MCP host proposals accept UTF-8 HTML, CSS,
and SVG only. Core validation rejects traversal, devices, case collisions, excessive counts/bytes,
undeclared local references, active content, remote schemes/resources, and malformed CSS.

`GenerationRecord` 1.0 retains the accepted manifest hash, generated file hashes/artifacts,
sanitized source and design-bundle artifacts, mode/layout/rendering inputs, decisions,
uncertainties, viewport classification, immutable pass evidence, report/ZIP/visual artifacts,
timings, warnings/failures/cancellation, and optional host/proposal provenance. Proposal passes state
whether they were accepted or reverted. Source fidelity has similarity/mismatch metrics; responsive
robustness without a matching reference has findings and no fidelity score.

The manifest hash is a deterministic SHA-256 over sorted relative path, media type, and content hash.
`export_generation` must present that exact hash and the complete accepted relative-path set before
the reproducible exporter writes a new empty contained directory.
