import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type { Config } from './config.js';
import {
  designBundleSchema,
  svgGenerationInputSchema,
  type DesignBundleNode,
  type SanitizationSummary,
  type SvgGenerationInput,
} from './generation-contracts.js';
import type { SvgInspectionResult, SvgStructureProvider } from './generation-providers.js';
import { SmartUiError } from './errors.js';
import type { ArtifactStore } from './providers.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const FALLBACK_FONTS = 'Arial, Helvetica, sans-serif';
const DANGEROUS_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'animate',
  'animatemotion',
  'animatetransform',
  'animatecolor',
  'set',
  'discard',
]);
const SUPPORTED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'image',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'title',
  'desc',
  'style',
  'filter',
  'fegaussianblur',
  'feoffset',
  'fecolormatrix',
  'feblend',
  'fecomposite',
  'femerge',
  'femergenode',
]);
const PRESENTATION_ATTRIBUTES = new Set([
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'display',
  'visibility',
  'clip-path',
  'mask',
  'filter',
]);

interface ParsedNode {
  name: string;
  attributes: Record<string, string>;
  children: ParsedNode[];
  text: string;
  parent?: ParsedNode;
  sourceNodeId: string;
  zOrder: number;
  computedStyle: Record<string, string>;
}

export class LocalSvgStructureProvider implements SvgStructureProvider {
  readonly name = 'local-svg-structure';
  readonly version = '1.0.0';

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly limits: Config['generation']['limits'],
  ) {}

  async inspect(
    inputValue: SvgGenerationInput,
    signal?: AbortSignal,
  ): Promise<SvgInspectionResult> {
    const input = svgGenerationInputSchema.parse(inputValue);
    throwIfAborted(signal);
    const svgPath = await containedRegularSvg(input.workspaceRoot, input.svgPath);
    const original = await readFile(svgPath);
    const originalHash = hash(original);
    const summary = emptySummary();
    if (original.byteLength > this.limits.maxSvgBytes) {
      failSvg(
        'SVG_TOO_LARGE',
        `SVG exceeds the ${this.limits.maxSvgBytes}-byte input budget.`,
        originalHash,
        summary,
        'invalid-svg',
      );
    }

    let xml: string;
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(original);
    } catch {
      failSvg('INVALID_UTF8', 'SVG must be strict UTF-8.', originalHash, summary, 'invalid-svg');
    }
    if (xml.length > this.limits.maxDecodedCharacters) {
      failSvg(
        'SVG_TEXT_TOO_LARGE',
        `Decoded SVG exceeds the ${this.limits.maxDecodedCharacters}-character budget.`,
        originalHash,
        summary,
        'invalid-svg',
      );
    }

    const unsupported = new Set<string>();
    const referencedIds = new Set<string>();
    const declaredIds = new Set<string>();
    const unavailableFonts = new Set<string>();
    const roots: ParsedNode[] = [];
    const stack: ParsedNode[] = [];
    let parseError: Error | undefined;
    let zOrder = 0;
    const parser = new SaxesParser({ xmlns: false, position: true });
    parser.on('xmldecl', (declaration) => {
      const encoding = declaration.encoding?.toLowerCase();
      if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
        parseError = unsafe(
          'ENCODING_MISMATCH',
          'The XML declaration must omit encoding or declare UTF-8.',
        );
      }
    });
    parser.on('doctype', () => {
      parseError = unsafe('DOCTYPE_OR_ENTITY', 'DOCTYPE and entity declarations are not allowed.');
    });
    parser.on('processinginstruction', () => {
      parseError = unsafe('PROCESSING_INSTRUCTION', 'Processing instructions are not allowed.');
    });
    parser.on('error', (error) => {
      parseError ??= error;
    });
    parser.on('opentag', (tag: SaxesTagPlain) => {
      if (parseError) return;
      throwIfAborted(signal);
      const name = localName(tag.name);
      summary.nodeCount++;
      const depth = stack.length + 1;
      summary.maxDepth = Math.max(summary.maxDepth, depth);
      if (summary.nodeCount > this.limits.maxNodes)
        parseError = budget('NODE_COUNT', this.limits.maxNodes);
      if (depth > this.limits.maxDepth) parseError = budget('DEPTH', this.limits.maxDepth);
      if (DANGEROUS_ELEMENTS.has(name))
        parseError = unsafe('DANGEROUS_ELEMENT', `SVG element <${name}> is not allowed.`);
      if (parseError) return;

      const attributes: Record<string, string> = {};
      for (const [attributeName, value] of Object.entries(tag.attributes)) {
        summary.attributeCount++;
        if (summary.attributeCount > this.limits.maxAttributes) {
          parseError = budget('ATTRIBUTE_COUNT', this.limits.maxAttributes);
          return;
        }
        validateAttribute(name, attributeName, value, summary, this.limits, referencedIds);
        attributes[attributeName] = value;
        if (localName(attributeName) === 'id') declaredIds.add(value);
      }
      if (name === 'path') {
        summary.pathDataCharacters += attributes['d']?.length ?? 0;
        if (summary.pathDataCharacters > this.limits.maxPathDataCharacters) {
          parseError = budget('PATH_DATA', this.limits.maxPathDataCharacters);
          return;
        }
      }
      if (name === 'lineargradient' || name === 'radialgradient') summary.gradientCount++;
      if (name === 'filter') summary.filterCount++;
      if (summary.gradientCount > this.limits.maxGradients)
        parseError = budget('GRADIENT_COUNT', this.limits.maxGradients);
      if (summary.filterCount > this.limits.maxFilters)
        parseError = budget('FILTER_COUNT', this.limits.maxFilters);
      if (parseError) return;

      const parent = stack.at(-1);
      const sourcePath = `${parent?.sourceNodeId ?? 'root'}/${name}:${parent?.children.length ?? roots.length}`;
      const node: ParsedNode = {
        name,
        attributes,
        children: [],
        text: '',
        ...(parent ? { parent } : {}),
        sourceNodeId: stableNodeId(sourcePath, attributes['id']),
        zOrder: zOrder++,
        computedStyle: inheritedStyle(parent, attributes),
      };
      if (!SUPPORTED_ELEMENTS.has(name)) unsupported.add(name);
      if (name === 'filter' || name.startsWith('fe')) unsupported.add(name);
      if (name === 'style') unsupported.add('stylesheet');
      const family = node.computedStyle['font-family'];
      if (family && !isFallbackFont(family)) unavailableFonts.add(family);
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
    });
    parser.on('text', (text) => {
      const current = stack.at(-1);
      if (!current || parseError) return;
      if (current.name === 'style') validateCssText(text, referencedIds);
      current.text += text;
    });
    parser.on('cdata', (text) => {
      const current = stack.at(-1);
      if (!current || parseError) return;
      if (current.name === 'style') validateCssText(text, referencedIds);
      current.text += text;
    });
    parser.on('closetag', () => {
      stack.pop();
    });

    try {
      parser.write(xml).close();
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
    }
    if (parseError) {
      const code = parseError.name === 'UnsafeSvgError' ? 'UNSAFE_SVG' : 'MALFORMED_XML';
      summary.rejectionCodes.push(code);
      failSvg(
        code,
        boundedMessage(parseError.message),
        originalHash,
        summary,
        parseError.name === 'UnsafeSvgError' ? 'unsafe-svg' : 'invalid-svg',
      );
    }
    if (roots.length !== 1 || roots[0]?.name !== 'svg') {
      failSvg(
        'INVALID_ROOT',
        'SVG must contain exactly one <svg> root element.',
        originalHash,
        summary,
        'invalid-svg',
      );
    }
    const root = roots[0]!;
    const namespace = root.attributes['xmlns'];
    if (namespace && namespace !== SVG_NAMESPACE) {
      failSvg(
        'INVALID_NAMESPACE',
        'The root SVG namespace is not supported.',
        originalHash,
        summary,
        'invalid-svg',
      );
    }
    for (const referenced of referencedIds) {
      if (!declaredIds.has(referenced)) unsupported.add(`unresolved-reference:${referenced}`);
    }

    const dimensions = resolveDimensions(root.attributes, input.viewport);
    if (!dimensions) {
      failSvg(
        'MISSING_DIMENSIONS',
        'SVG requires positive width/height or a usable viewBox.',
        originalHash,
        summary,
        'invalid-svg',
      );
    }
    const sanitizedXml = serializeNode(root);
    const sanitizedBytes = new TextEncoder().encode(sanitizedXml);
    const sanitizedHash = hash(sanitizedBytes);
    const sanitizedSvg = await this.artifacts.put(
      sanitizedBytes,
      'image/svg+xml',
      'sanitized-reference.svg',
    );
    summary.accepted = true;
    summary.decisions.push('Parsed as strict UTF-8 with DTDs, entities, and processing disabled.');
    summary.decisions.push('Canonicalized element and attribute serialization deterministically.');

    const flatNodes = flatten(root).map(toBundleNode);
    const textNodes = flatNodes.filter((node) => node.type === 'text' && node.text?.trim());
    const pathCount = flatNodes.filter((node) => node.type === 'path').length;
    const embeddedImages = flatNodes.filter((node) => node.type === 'image');
    const overlapGroups = excessiveOverlapGroups(root);
    const uncertainties = [
      ...(textNodes.length === 0
        ? [
            {
              code: 'NO_READABLE_TEXT',
              message: 'No readable <text> nodes were found; semantic copy cannot be inferred.',
              sourceNodeIds: [],
              confidence: 1,
            },
          ]
        : []),
      ...(textNodes.length === 0 && pathCount > 0
        ? [
            {
              code: 'TEXT_MAY_BE_OUTLINED',
              message:
                'The SVG contains paths but no readable text; outlined copy is retained without fabricated semantics.',
              sourceNodeIds: [],
              confidence: 0.8,
            },
          ]
        : []),
      ...(embeddedImages.length > 0
        ? [
            {
              code: 'EMBEDDED_RASTER_CONTENT',
              message:
                'Embedded raster content is retained with explicit bounds; alternative text requires user evidence.',
              sourceNodeIds: embeddedImages.map((node) => node.id),
              confidence: 1,
            },
          ]
        : []),
      ...(overlapGroups.length > 0
        ? [
            {
              code: 'EXCESSIVE_ABSOLUTE_OVERLAP',
              message:
                'Overlapping geometry makes semantic layout inference uncertain; affected artwork remains vector content.',
              sourceNodeIds: overlapGroups,
              confidence: 0.9,
            },
          ]
        : []),
      ...(unavailableFonts.size > 0
        ? [
            {
              code: 'UNAVAILABLE_FONTS',
              message: `Offline fallback fonts will replace: ${[...unavailableFonts].sort().join(', ')}.`,
              sourceNodeIds: textNodes.map((node) => node.id),
              confidence: 1,
            },
          ]
        : []),
      ...[...unsupported].sort().map((construct) => ({
        code: 'UNSUPPORTED_CONSTRUCT',
        message: `Construct '${construct}' is retained as exact vector artwork.`,
        sourceNodeIds: [],
        confidence: 1,
      })),
    ];
    const colors = repeatedValues(flatNodes, ['fill', 'stroke']);
    const typography = repeatedValues(flatNodes, ['font-size', 'font-weight']);
    const layoutCandidates = detectLayouts(root);
    const semanticCandidates = detectSemantics(flatNodes, layoutCandidates, dimensions);
    const bundle = designBundleSchema.parse({
      schemaVersion: '1.0',
      id: `svg-${sanitizedHash.slice(7, 31)}`,
      name: input.name ?? basename(input.svgPath, extname(input.svgPath)),
      originalInputHash: originalHash,
      sanitizedHash,
      capturedAt: new Date().toISOString(),
      viewport: { ...dimensions, deviceScaleFactor: input.viewport?.deviceScaleFactor ?? 1 },
      referenceBackground:
        input.rendering.background.kind === 'color'
          ? input.rendering.background.value
          : 'transparent',
      sanitizedSvg,
      sanitization: summary,
      scene: { rootNodeId: flatNodes[0]!.id, nodes: flatNodes },
      repeatedValues: { colors, typography },
      layoutCandidates,
      semanticCandidates,
      uncertainties,
      unsupportedConstructs: [...unsupported].sort(),
      fontPolicy: { fallbackStack: FALLBACK_FONTS, unavailableFonts: [...unavailableFonts].sort() },
      ...(input.instructions ? { instructions: input.instructions } : {}),
      provenance: { provider: this.name, version: this.version, source: svgPath },
    });
    if (pathCount > 20 && pathCount > textNodes.length * 5) {
      bundle.uncertainties.push({
        code: 'PATH_HEAVY_ARTWORK',
        message: 'Path-heavy artwork should remain exact vector content.',
        sourceNodeIds: [],
        confidence: 0.95,
      });
    }
    return { bundle, sanitizedXml, sanitizedXmlWithoutText: serializeNode(root, true) };
  }
}

function emptySummary(): SanitizationSummary {
  return {
    accepted: false,
    nodeCount: 0,
    maxDepth: 0,
    attributeCount: 0,
    pathDataCharacters: 0,
    gradientCount: 0,
    filterCount: 0,
    embeddedImageCount: 0,
    embeddedImageBytes: 0,
    decisions: [],
    rejectionCodes: [],
  };
}

async function containedRegularSvg(workspaceRoot: string, path: string): Promise<string> {
  const declaredWorkspace = resolve(workspaceRoot);
  const workspace = await realpath(declaredWorkspace);
  const resolved = resolve(path);
  const rel = relative(declaredWorkspace, resolved);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new SmartUiError('POLICY_VIOLATION', 'SVG path escapes the declared workspace.');
  if (extname(resolved).toLowerCase() !== '.svg')
    throw new SmartUiError('INVALID_INPUT', 'Generation input must be a .svg file.');
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink())
    throw new SmartUiError('INVALID_INPUT', 'Generation input must be a regular SVG file.');
  const canonical = await realpath(resolved);
  const canonicalRel = relative(workspace, canonical);
  if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel))
    throw new SmartUiError('POLICY_VIOLATION', 'SVG path crosses a link outside the workspace.');
  return canonical;
}

function validateAttribute(
  element: string,
  rawName: string,
  value: string,
  summary: SanitizationSummary,
  limits: Config['generation']['limits'],
  referencedIds: Set<string>,
): void {
  const name = localName(rawName);
  const lowered = value.trim().toLowerCase();
  if (name.startsWith('on'))
    throw unsafe('EVENT_HANDLER', `Event-handler attribute '${rawName}' is not allowed.`);
  if (lowered.startsWith('javascript:') || lowered.startsWith('vbscript:'))
    throw unsafe('SCRIPT_URL', `Script URL in '${rawName}' is not allowed.`);
  if (name === 'style') validateCssText(value, referencedIds);
  for (const reference of cssUrls(value)) {
    if (!reference.startsWith('#'))
      throw unsafe('EXTERNAL_RESOURCE', `External resource in '${rawName}' is not allowed.`);
    referencedIds.add(reference.slice(1));
  }
  if (!['href', 'src'].includes(name)) return;
  if (value.startsWith('#')) {
    referencedIds.add(value.slice(1));
    return;
  }
  if (element !== 'image' || !lowered.startsWith('data:'))
    throw unsafe('EXTERNAL_RESOURCE', `External '${rawName}' resource is not allowed.`);
  const decoded = decodeDataImage(value);
  summary.embeddedImageCount++;
  summary.embeddedImageBytes += decoded.byteLength;
  if (summary.embeddedImageCount > limits.maxEmbeddedImages)
    throw budget('EMBEDDED_IMAGE_COUNT', limits.maxEmbeddedImages);
  if (summary.embeddedImageBytes > limits.maxEmbeddedImageBytes)
    throw budget('EMBEDDED_IMAGE_BYTES', limits.maxEmbeddedImageBytes);
}

function validateCssText(value: string, referencedIds: Set<string>): void {
  const lowered = value.toLowerCase();
  if (lowered.includes('@import')) throw unsafe('CSS_IMPORT', 'CSS imports are not allowed.');
  if (lowered.includes('@font-face'))
    throw unsafe('EXTERNAL_FONT', 'Embedded or external CSS fonts are not allowed in Phase 1.');
  if (lowered.includes('javascript:') || lowered.includes('expression('))
    throw unsafe('UNSAFE_CSS', 'Executable CSS is not allowed.');
  if (lowered.includes('/*'))
    throw unsafe('CSS_COMMENT', 'CSS comments are rejected to prevent token obfuscation.');
  if (value.includes('\\'))
    throw unsafe('CSS_ESCAPE', 'CSS escapes are rejected to avoid ambiguous URL interpretation.');
  for (const reference of cssUrls(value)) {
    if (!reference.startsWith('#'))
      throw unsafe('EXTERNAL_RESOURCE', 'CSS may reference local SVG fragments only.');
    referencedIds.add(reference.slice(1));
  }
}

function cssUrls(value: string): string[] {
  const lowered = value.toLowerCase();
  const results: string[] = [];
  let cursor = 0;
  while (cursor < lowered.length) {
    const start = lowered.indexOf('url', cursor);
    if (start === -1) break;
    let open = start + 3;
    while (isWhitespace(lowered[open])) open++;
    if (lowered[open] !== '(') {
      cursor = open;
      continue;
    }
    const close = lowered.indexOf(')', open + 1);
    if (close === -1) throw unsafe('MALFORMED_CSS_URL', 'Malformed CSS url() value.');
    let content = value.slice(open + 1, close).trim();
    if (
      (content.startsWith('"') && content.endsWith('"')) ||
      (content.startsWith("'") && content.endsWith("'"))
    ) {
      content = content.slice(1, -1).trim();
    }
    results.push(content);
    cursor = close + 1;
  }
  return results;
}

function decodeDataImage(value: string): Uint8Array {
  const comma = value.indexOf(',');
  if (comma === -1) throw unsafe('INVALID_DATA_URL', 'Malformed image data URL.');
  const metadata = value.slice(5, comma).toLowerCase();
  const mediaType = metadata.split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType ?? ''))
    throw unsafe('DATA_MEDIA_TYPE', `Embedded media type '${mediaType}' is not allowed.`);
  try {
    const payload = value.slice(comma + 1);
    if (metadata.includes(';base64')) {
      if (!isStrictBase64(payload)) throw new Error('invalid base64');
      return Uint8Array.from(Buffer.from(payload, 'base64'));
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    throw unsafe('INVALID_DATA_URL', 'Embedded image data could not be decoded.');
  }
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let paddingStarted = false;
  let padding = 0;
  for (const character of value) {
    if (character === '=') {
      paddingStarted = true;
      padding++;
      if (padding > 2) return false;
      continue;
    }
    const code = character.codePointAt(0)!;
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      character === '+' ||
      character === '/';
    if (!allowed || paddingStarted) return false;
  }
  return true;
}

function inheritedStyle(
  parent: ParsedNode | undefined,
  attributes: Record<string, string>,
): Record<string, string> {
  const style = { ...(parent?.computedStyle ?? {}) };
  for (const [name, value] of Object.entries(attributes)) {
    const local = localName(name);
    if (PRESENTATION_ATTRIBUTES.has(local)) style[local] = value;
  }
  const inline = attributes['style'];
  if (inline) {
    for (const declaration of inline.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon <= 0) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (PRESENTATION_ATTRIBUTES.has(name) && value) style[name] = value;
    }
  }
  return style;
}

function flatten(root: ParsedNode): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  const visit = (node: ParsedNode) => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return nodes;
}

function toBundleNode(node: ParsedNode): DesignBundleNode {
  const text = ['text', 'tspan', 'title', 'desc'].includes(node.name)
    ? collectText(node).trim().replace(/\s+/g, ' ')
    : undefined;
  return {
    id: node.sourceNodeId,
    ...(node.attributes['id'] ? { sourceId: node.attributes['id'] } : {}),
    type: node.name,
    ...(node.parent ? { parentId: node.parent.sourceNodeId } : {}),
    childIds: node.children.map((child) => child.sourceNodeId),
    zOrder: node.zOrder,
    visible:
      node.computedStyle['display'] !== 'none' && node.computedStyle['visibility'] !== 'hidden',
    attributes: node.attributes,
    computedStyle: node.computedStyle,
    ...(() => {
      const bounds = nodeBounds(node);
      return bounds ? { bounds } : {};
    })(),
    ...(() => {
      const transform = effectiveTransform(node);
      return transform ? { transform } : {};
    })(),
    ...(text ? { text } : {}),
    outlinedText: false,
  };
}

function effectiveTransform(node: ParsedNode): string | undefined {
  const transforms: string[] = [];
  let current: ParsedNode | undefined = node;
  while (current) {
    if (current.attributes['transform']) transforms.unshift(current.attributes['transform']);
    current = current.parent;
  }
  return transforms.length > 0 ? transforms.join(' ') : undefined;
}

function nodeBounds(
  node: ParsedNode,
): { x: number; y: number; width: number; height: number } | null {
  const a = node.attributes;
  if (node.name === 'rect' || node.name === 'image') {
    return {
      x: number(a['x']),
      y: number(a['y']),
      width: number(a['width']),
      height: number(a['height']),
    };
  }
  if (node.name === 'circle') {
    const r = number(a['r']);
    return { x: number(a['cx']) - r, y: number(a['cy']) - r, width: r * 2, height: r * 2 };
  }
  if (node.name === 'ellipse') {
    const rx = number(a['rx']);
    const ry = number(a['ry']);
    return { x: number(a['cx']) - rx, y: number(a['cy']) - ry, width: rx * 2, height: ry * 2 };
  }
  if (node.name === 'text' || node.name === 'tspan') {
    const size = fontSize(node.computedStyle['font-size']);
    const text = collectText(node).trim();
    return {
      x: number(a['x']),
      y: number(a['y']) - size,
      width: text.length * size * 0.6,
      height: size * 1.2,
    };
  }
  if (node.name === 'g' || node.name === 'svg') {
    const childBounds = node.children.map(nodeBounds).filter((value) => value !== null);
    if (childBounds.length === 0) return null;
    const left = Math.min(...childBounds.map((value) => value.x));
    const top = Math.min(...childBounds.map((value) => value.y));
    const right = Math.max(...childBounds.map((value) => value.x + value.width));
    const bottom = Math.max(...childBounds.map((value) => value.y + value.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  return null;
}

function excessiveOverlapGroups(root: ParsedNode): string[] {
  const groups: string[] = [];
  for (const node of flatten(root)) {
    if (!['g', 'svg'].includes(node.name) || node.children.length < 3) continue;
    const bounds = node.children.map(nodeBounds).filter((value) => value !== null);
    let overlappingPairs = 0;
    let comparedPairs = 0;
    for (let left = 0; left < bounds.length; left++) {
      for (let right = left + 1; right < bounds.length; right++) {
        comparedPairs++;
        if (overlaps(bounds[left]!, bounds[right]!)) overlappingPairs++;
      }
    }
    if (comparedPairs > 0 && overlappingPairs / comparedPairs > 0.5) {
      groups.push(node.sourceNodeId);
    }
  }
  return groups;
}

function overlaps(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function detectLayouts(root: ParsedNode) {
  const decisions: Array<{
    kind: string;
    message: string;
    sourceNodeIds: string[];
    confidence: number;
    provenance: string;
  }> = [];
  for (const node of flatten(root)) {
    if (!['g', 'svg'].includes(node.name) || node.children.length < 2) continue;
    const bounds = node.children.map(nodeBounds);
    if (bounds.some((value) => !value)) continue;
    const values = bounds as Array<{ x: number; y: number; width: number; height: number }>;
    const horizontal = monotonic(values.map((value) => value.x));
    const vertical = monotonic(values.map((value) => value.y));
    const columns = coordinateClusters(values.map((value) => value.x));
    const rows = coordinateClusters(values.map((value) => value.y));
    if (values.length >= 4 && columns >= 2 && rows >= 2) {
      decisions.push({
        kind: 'grid',
        message: 'Repeated sibling geometry forms a deterministic grid candidate.',
        sourceNodeIds: [node.sourceNodeId],
        confidence: 0.86,
        provenance: 'deterministic-geometry',
      });
    } else if (horizontal && spread(values.map((value) => value.y)) <= 4) {
      decisions.push({
        kind: 'horizontal',
        message: 'Sibling geometry forms a high-confidence horizontal layout candidate.',
        sourceNodeIds: [node.sourceNodeId],
        confidence: 0.9,
        provenance: 'deterministic-geometry',
      });
    } else if (vertical && spread(values.map((value) => value.x)) <= 4) {
      decisions.push({
        kind: 'vertical',
        message: 'Sibling geometry forms a high-confidence vertical layout candidate.',
        sourceNodeIds: [node.sourceNodeId],
        confidence: 0.9,
        provenance: 'deterministic-geometry',
      });
    }
  }
  return decisions;
}

function detectSemantics(
  nodes: DesignBundleNode[],
  layouts: ReturnType<typeof detectLayouts>,
  viewport: { width: number; height: number },
) {
  const candidates: Array<{
    kind: string;
    message: string;
    sourceNodeIds: string[];
    confidence: number;
    provenance: string;
  }> = [];
  const textNodes = nodes
    .filter((node) => node.type === 'text' && node.text?.trim())
    .sort(
      (left, right) =>
        (left.bounds?.y ?? 0) - (right.bounds?.y ?? 0) ||
        (left.bounds?.x ?? 0) - (right.bounds?.x ?? 0) ||
        left.zOrder - right.zOrder,
    );
  const headingSizes = [
    ...new Set(
      textNodes
        .map((node) => fontSize(node.computedStyle['font-size']))
        .filter((size) => size >= 24),
    ),
  ].sort((left, right) => right - left);
  for (const node of textNodes) {
    const size = fontSize(node.computedStyle['font-size']);
    const headingIndex = headingSizes.indexOf(size);
    candidates.push({
      kind: headingIndex >= 0 ? 'heading' : 'paragraph',
      message:
        headingIndex >= 0
          ? `Readable large text is a deterministic heading level ${Math.min(headingIndex + 1, 6)} candidate.`
          : 'Readable SVG text is a high-confidence paragraph candidate.',
      sourceNodeIds: [node.id],
      confidence: 0.9,
      provenance: 'deterministic-svg-structure',
    });
  }
  if (textNodes.length > 1) {
    candidates.push({
      kind: 'reading-order',
      message: 'Readable text has a deterministic top-to-bottom, left-to-right order candidate.',
      sourceNodeIds: textNodes.map((node) => node.id),
      confidence: 0.9,
      provenance: 'deterministic-geometry',
    });
  }
  for (const node of nodes.filter((candidate) => candidate.type === 'image')) {
    candidates.push({
      kind: 'image',
      message:
        'An embedded image has explicit geometry but requires user-provided alternative text.',
      sourceNodeIds: [node.id],
      confidence: 1,
      provenance: 'deterministic-svg-structure',
    });
  }
  for (const layout of layouts) {
    if (layout.kind === 'grid') {
      candidates.push({
        kind: 'repeated-card-list',
        message:
          'The grid may represent repeated cards or decorative artwork; semantics require confirmation.',
        sourceNodeIds: layout.sourceNodeIds,
        confidence: 0.65,
        provenance: 'deterministic-geometry',
      });
    }
    if (layout.kind === 'horizontal') {
      candidates.push({
        kind: 'navigation-or-list',
        message: 'The horizontal group may be navigation or a list; no link behavior is inferred.',
        sourceNodeIds: layout.sourceNodeIds,
        confidence: 0.6,
        provenance: 'deterministic-geometry',
      });
    }
  }
  const contentNodes = nodes.filter(
    (node) =>
      node.visible &&
      node.bounds &&
      node.type !== 'defs' &&
      node.type !== 'svg' &&
      node.bounds.width > 0,
  );
  if (contentNodes.length > 0) {
    const left = Math.min(...contentNodes.map((node) => node.bounds!.x));
    const right = Math.max(...contentNodes.map((node) => node.bounds!.x + node.bounds!.width));
    candidates.push({
      kind: 'content-width',
      message: `Observed content spans ${Math.max(0, right - left).toFixed(2)} of ${viewport.width} source pixels; responsive breakpoints must be validated from overflow, not device names.`,
      sourceNodeIds: [],
      confidence: 1,
      provenance: 'deterministic-geometry',
    });
  }
  return candidates;
}

function coordinateClusters(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  let count = 0;
  let previous: number | undefined;
  for (const value of sorted) {
    if (previous === undefined || Math.abs(value - previous) > 4) count++;
    previous = value;
  }
  return count;
}

function repeatedValues(nodes: DesignBundleNode[], properties: string[]): string[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const property of properties) {
      const value = node.computedStyle[property];
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function resolveDimensions(
  attributes: Record<string, string>,
  override: SvgGenerationInput['viewport'],
): { width: number; height: number } | null {
  if (override) return { width: override.width, height: override.height };
  const width = positiveDimension(attributes['width']);
  const height = positiveDimension(attributes['height']);
  if (width && height) return { width: Math.ceil(width), height: Math.ceil(height) };
  const parts = (attributes['viewBox'] ?? attributes['viewbox'] ?? '').split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) {
    return { width: Math.ceil(parts[2]!), height: Math.ceil(parts[3]!) };
  }
  return null;
}

function serializeNode(node: ParsedNode, omitText = false): string {
  if (omitText && (node.name === 'text' || node.name === 'tspan')) return '';
  const attributes = Object.entries(node.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  const content = `${escapeText(node.text)}${node.children.map((child) => serializeNode(child, omitText)).join('')}`;
  return content
    ? `<${node.name}${attributes}>${content}</${node.name}>`
    : `<${node.name}${attributes}/>`;
}

function collectText(node: ParsedNode): string {
  return `${node.text}${node.children.map(collectText).join(' ')}`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function localName(name: string): string {
  return (name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name).toLowerCase();
}

function stableNodeId(path: string, sourceId: string | undefined): string {
  const suffix = createHash('sha256').update(path).digest('hex').slice(0, 16);
  const prefix = sourceId
    ? sourceId
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .slice(0, 32)
    : 'node';
  return `${prefix}-${suffix}`;
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function unsafe(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  error.name = 'UnsafeSvgError';
  return error;
}

function budget(name: string, limit: number): Error {
  const error = new Error(`${name} exceeds the configured budget of ${limit}.`);
  error.name = 'SvgBudgetError';
  return error;
}

function failSvg(
  code: string,
  message: string,
  originalHash: string,
  summary: SanitizationSummary,
  stoppedReason: 'invalid-svg' | 'unsafe-svg',
): never {
  if (!summary.rejectionCodes.includes(code)) summary.rejectionCodes.push(code);
  throw new SmartUiError('INVALID_INPUT', message, {
    originalHash,
    sanitization: summary,
    stoppedReason,
  });
}

function boundedMessage(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 500);
}

function number(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveDimension(value: string | undefined): number | null {
  if (!value || value.trim().endsWith('%')) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function fontSize(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '16');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

function isFallbackFont(value: string): boolean {
  const normalized = value.toLowerCase();
  return ['arial', 'helvetica', 'sans-serif', 'serif', 'monospace', 'system-ui'].some((font) =>
    normalized.includes(font),
  );
}

function monotonic(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value >= values[index - 1]!);
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function isWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SmartUiError('PROVIDER_FAILURE', 'SVG generation was canceled.');
}
