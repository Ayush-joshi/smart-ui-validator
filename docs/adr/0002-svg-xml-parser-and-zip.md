# ADR 0002: bounded SVG XML parsing and reproducible ZIPs

Status: Accepted

Date: 2026-08-10

## Context

SVG generation accepts untrusted local XML. The intake boundary must reject DTDs, entity
declarations, processing instructions, executable elements, active attributes, and external
resources before any browser sees the document. It also needs deterministic structural events so
node, depth, attribute, path, filter, gradient, and embedded-image budgets can stop parsing early.

Generation exports must be reproducible without a platform ZIP executable or arbitrary command
execution.

## Decision

Use `saxes@6.0.0`, pinned exactly, as a strict streaming non-validating XML parser. Smart UI owns the
security policy around its events:

- the `doctype` and non-declaration processing-instruction events reject the whole input;
- only the predefined entities accepted by strict XML are decoded; custom entities cannot be
  registered;
- structural budgets are enforced while consuming open-tag and attribute events;
- SVG elements and attributes are checked before being admitted to the normalized tree;
- canonical SVG is serialized from the accepted tree rather than by rewriting untrusted source
  text; and
- unsafe raw XML is never stored or rendered.

The package describes itself as a stricter, SAX-style XML parser and ships TypeScript declarations:
<https://www.npmjs.com/package/saxes>. Its source documentation confirms that DTD entity resolution
requires an explicit application action that Smart UI does not perform:
<https://github.com/lddubeau/saxes>.

Create ZIP files in core with the uncompressed ZIP format. Entries are sorted, UTF-8 encoded, fixed
to the DOS epoch, assigned mode `0644`, protected by CRC-32, and written without platform metadata or
comments. Avoiding compression makes identical accepted bytes produce identical archives across
hosts and avoids another dependency at this stage.

## Rejected alternatives

- `fast-xml-parser`: capable and actively maintained, but it supports DTD/entity processing and has
  had multiple 2026 entity-expansion and builder advisories. Smart UI would have to defend a larger
  feature surface that this workflow rejects entirely.
- Browser `DOMParser`: would move structural/security parsing into the browser boundary and make it
  easier to accidentally render or resolve evidence before policy acceptance.
- Regular expressions: cannot establish XML well-formedness, namespaces, nesting, or safe entity
  behavior and are prohibited as the structural/security parser.
- A system `zip` command: violates host-neutral command policy and can vary timestamps, permissions,
  ordering, compression output, and installed availability.

## Consequences

Phase 1 supports strict XML SVG rather than browser-tolerated pseudo-XML. CSS escapes are rejected at
the SVG security boundary to avoid ambiguous URL interpretation. Advanced safe SVG constructs may
remain exact vector artwork with an uncertainty instead of being semantically approximated.

The ZIP implementation intentionally uses stored entries, so archives can be larger than compressed
archives. The generation output budget keeps that cost bounded.
