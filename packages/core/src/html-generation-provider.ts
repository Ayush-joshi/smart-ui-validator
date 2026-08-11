import { createHash } from 'node:crypto';
import type {
  DesignBundleNode,
  GeneratedHtmlBundle,
  GeneratedHtmlFile,
  GenerationDecision,
  GenerationUncertainty,
  SvgGenerationInput,
} from './generation-contracts.js';
import type { HtmlGenerationProvider, SvgInspectionResult } from './generation-providers.js';
import { SmartUiError } from './errors.js';

const encoder = new TextEncoder();

export class DeterministicHtmlGenerationProvider implements HtmlGenerationProvider {
  readonly name = 'deterministic-svg-html';
  readonly version = '1.0.0';

  async generate(
    input: SvgGenerationInput,
    inspection: SvgInspectionResult,
    signal?: AbortSignal,
  ): Promise<GeneratedHtmlBundle> {
    if (signal?.aborted) throw new SmartUiError('PROVIDER_FAILURE', 'Generation was canceled.');
    const requestedMode = input.mode;
    const semanticText = inspection.bundle.scene.nodes.filter(
      (node) =>
        node.type === 'text' && node.text?.trim() && node.bounds && !node.transform && node.visible,
    );
    const controls = new Map(
      semanticText.flatMap((node) => {
        const bounds = inferControlBounds(
          inspection.bundle.scene.nodes,
          node,
          inspection.bundle.viewport,
        );
        return bounds ? [[node.id, bounds] as const] : [];
      }),
    );
    const semanticGroups = inferSemanticGroups(
      inspection.bundle.scene.nodes,
      inspection.bundle.layoutCandidates,
      semanticText,
      controls,
    );
    const groupedNodeIds = new Set(
      semanticGroups.flatMap((group) => group.nodes.map((node) => node.id)),
    );
    const mustFallback =
      requestedMode !== 'exact' &&
      (semanticText.length === 0 || inspection.bundle.unsupportedConstructs.length > 0);
    const finalMode = requestedMode === 'exact' || mustFallback ? 'exact' : requestedMode;
    const decisions: GenerationDecision[] = [
      {
        kind: finalMode === 'exact' ? 'exact-vector-shell' : 'hybrid-semantic-text',
        message:
          finalMode === 'exact'
            ? 'Retained the complete sanitized SVG in a semantic, script-free document shell.'
            : 'Projected high-confidence readable text into semantic HTML and retained artwork as inline SVG.',
        sourceNodeIds: finalMode === 'exact' ? [] : semanticText.map((node) => node.id),
        confidence: 1,
        provenance: `${this.name}@${this.version}`,
      },
      ...inspection.bundle.layoutCandidates,
      ...inspection.bundle.semanticCandidates.filter((candidate) =>
        semanticText.some((node) => candidate.sourceNodeIds.includes(node.id)),
      ),
      ...[...controls.keys()].map((sourceNodeId) => ({
        kind: 'button',
        message:
          'Text inside a control-sized rectangle is emitted as a non-submitting button without invented behavior.',
        sourceNodeIds: [sourceNodeId],
        confidence: 0.92,
        provenance: 'deterministic-svg-geometry',
      })),
    ];
    const uncertainties: GenerationUncertainty[] = [...inspection.bundle.uncertainties];
    if (mustFallback) {
      uncertainties.push({
        code: 'EXACT_FALLBACK',
        message:
          semanticText.length === 0
            ? 'Hybrid generation fell back to exact mode because no high-confidence readable text was available.'
            : 'Hybrid generation fell back to exact mode because unsupported constructs require intact vector rendering.',
        sourceNodeIds: [],
        confidence: 1,
      });
    }

    const { width, height } = inspection.bundle.viewport;
    const presentation = inspection.bundle.presentationSpec;
    const background =
      input.rendering.background.kind === 'color'
        ? input.rendering.background.value
        : 'transparent';
    const artwork =
      finalMode === 'exact' ? inspection.sanitizedXml : inspection.sanitizedXmlWithoutText;
    const semantic =
      finalMode === 'exact'
        ? ''
        : [
            ...semanticGroups.map((group) => semanticGroupElement(group, width, height)),
            ...semanticText
              .filter((node) => !groupedNodeIds.has(node.id))
              .map((node) => semanticElement(node, width, height, controls.get(node.id))),
          ].join('\n      ');
    const title = escapeHtml(inspection.bundle.name);
    const html = `<!doctype html>
<html lang="${escapeAttribute(input.rendering.locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="smart-ui ${this.version}">
  <title>${title}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="generated-ui" aria-label="${title}">
    <div class="canvas" data-generation-mode="${finalMode}">
      <div class="artwork"${finalMode === 'exact' ? '' : ' aria-hidden="true"'}>${artwork}</div>
      ${semantic ? `<div class="semantic-layer">${semantic}</div>` : ''}
    </div>
  </main>
</body>
</html>
`;
    const variables = cssVariables(inspection.bundle.repeatedValues);
    const responsive = input.layout === 'responsive';
    const canvasLayout = usesExplicitCanvasLayout(presentation, width, height)
      ? presentationCanvasCss(presentation, width, height)
      : `.generated-ui { margin: 0; width: 100%; }
.canvas {
  position: relative;
  width: ${responsive ? `min(100%, ${width}px)` : `${width}px`};
  aspect-ratio: ${width} / ${height};
  overflow: hidden;
  container-type: inline-size;
  background: var(--smart-ui-background);
}`;
    const css = `:root {
  --smart-ui-width: ${width};
  --smart-ui-height: ${height};
  --smart-ui-background: ${background};
  --smart-ui-font-stack: ${inspection.bundle.fontPolicy.fallbackStack};${variables}
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--smart-ui-background); }
body { font-family: var(--smart-ui-font-stack); }
${canvasLayout}
.artwork, .semantic-layer { position: absolute; inset: 0; width: 100%; height: 100%; }
.artwork svg { display: block; width: 100%; height: 100%; }
.semantic-layer { pointer-events: none; }
.semantic-node {
  position: absolute;
  margin: 0;
  white-space: pre;
  line-height: 1.2;
  transform-origin: top left;
}
.semantic-node--control {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
}
.semantic-group {
  position: absolute;
  display: flex;
  align-items: flex-start;
  margin: 0;
}
.semantic-group .semantic-node { position: static; }
`;
    const files: GeneratedHtmlFile[] = [
      {
        relativePath: 'index.html',
        mediaType: 'text/html',
        bytes: encoder.encode(html),
        rationale: 'Offline semantic document shell for the accepted SVG generation.',
        sourceNodeIds: [],
      },
      {
        relativePath: 'styles.css',
        mediaType: 'text/css',
        bytes: encoder.encode(css),
        rationale: 'Deterministic local layout, typography, and repeated-value tokens.',
        sourceNodeIds: semanticText.map((node) => node.id),
      },
    ];
    return { files, decisions, uncertainties, finalMode };
  }
}

function usesExplicitCanvasLayout(
  presentation: SvgInspectionResult['bundle']['presentationSpec'],
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  return !(
    presentation.fit === 'intrinsic' &&
    presentation.horizontalAlignment === 'start' &&
    presentation.verticalAlignment === 'start' &&
    presentation.primaryCanvas.width === sourceWidth &&
    presentation.primaryCanvas.height === sourceHeight
  );
}

function presentationCanvasCss(
  presentation: SvgInspectionResult['bundle']['presentationSpec'],
  sourceWidth: number,
  sourceHeight: number,
): string {
  const target = presentation.primaryCanvas;
  const availableX = target.width / sourceWidth;
  const availableY = target.height / sourceHeight;
  const [scaleX, scaleY] =
    presentation.fit === 'stretch'
      ? [availableX, availableY]
      : presentation.fit === 'contain'
        ? [Math.min(availableX, availableY), Math.min(availableX, availableY)]
        : presentation.fit === 'cover'
          ? [Math.max(availableX, availableY), Math.max(availableX, availableY)]
          : [1, 1];
  const renderedWidth = sourceWidth * scaleX;
  const renderedHeight = sourceHeight * scaleY;
  const offsetX = alignmentOffset(target.width - renderedWidth, presentation.horizontalAlignment);
  const offsetY = alignmentOffset(target.height - renderedHeight, presentation.verticalAlignment);
  return `.generated-ui {
  position: relative;
  margin: 0;
  width: ${target.width}px;
  height: ${target.height}px;
  overflow: hidden;
  background: var(--smart-ui-background);
}
.canvas {
  position: absolute;
  width: ${sourceWidth}px;
  height: ${sourceHeight}px;
  overflow: hidden;
  container-type: inline-size;
  background: var(--smart-ui-background);
  transform-origin: top left;
  transform: translate(${decimal(offsetX)}px, ${decimal(offsetY)}px) scale(${decimal(scaleX)}, ${decimal(scaleY)});
}`;
}

function alignmentOffset(remaining: number, alignment: 'start' | 'center' | 'end'): number {
  return alignment === 'center' ? remaining / 2 : alignment === 'end' ? remaining : 0;
}

function semanticElement(
  node: DesignBundleNode,
  width: number,
  height: number,
  controlBounds?: { x: number; y: number; width: number; height: number },
): string {
  const bounds = controlBounds ?? node.bounds!;
  const size = positiveNumber(node.computedStyle['font-size'], Math.max(1, bounds.height / 1.2));
  const x = (bounds.x / width) * 100;
  const y = (bounds.y / height) * 100;
  const fontSize = (size / width) * 100;
  const color = safeCssValue(node.computedStyle['fill'] ?? '#000');
  const weight = safeCssValue(node.computedStyle['font-weight'] ?? '400');
  const family = safeCssValue(node.computedStyle['font-family'] ?? 'var(--smart-ui-font-stack)');
  const tag = controlBounds ? 'button' : size >= 32 ? 'h1' : size >= 24 ? 'h2' : 'p';
  const validationId = `svg-${createHash('sha256').update(node.id).digest('hex').slice(0, 16)}`;
  const sizeStyle = controlBounds
    ? `width:${decimal((bounds.width / width) * 100)}%;height:${decimal((bounds.height / height) * 100)}%;`
    : '';
  return `<${tag}${controlBounds ? ' type="button"' : ''} class="semantic-node${controlBounds ? ' semantic-node--control' : ''}" data-validation-id="${validationId}" data-source-node-id="${escapeAttribute(node.id)}" style="left:${decimal(x)}%;top:${decimal(y)}%;${sizeStyle}font-size:${decimal(fontSize)}cqw;color:${escapeAttribute(color)};font-weight:${escapeAttribute(weight)};font-family:${escapeAttribute(family)}">${escapeHtml(node.text ?? '')}</${tag}>`;
}

export function inferControlBounds(
  nodes: DesignBundleNode[],
  text: DesignBundleNode,
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | undefined {
  if (!text.bounds || text.transform) return undefined;
  return nodes.find((candidate) => {
    const bounds = candidate.bounds;
    if (
      candidate.type !== 'rect' ||
      candidate.parentId !== text.parentId ||
      !bounds ||
      candidate.transform ||
      bounds.width < 40 ||
      bounds.width > viewport.width * 0.6 ||
      bounds.height < 24 ||
      bounds.height > Math.min(96, viewport.height * 0.4)
    ) {
      return false;
    }
    const centerY = text.bounds!.y + text.bounds!.height / 2;
    return (
      text.bounds!.x >= bounds.x &&
      text.bounds!.x <= bounds.x + bounds.width &&
      centerY >= bounds.y &&
      centerY <= bounds.y + bounds.height
    );
  })?.bounds;
}

interface SemanticGroup {
  direction: 'horizontal' | 'vertical';
  bounds: { x: number; y: number; width: number; height: number };
  gap: number;
  nodes: DesignBundleNode[];
}

function inferSemanticGroups(
  nodes: DesignBundleNode[],
  candidates: GenerationDecision[],
  semanticText: DesignBundleNode[],
  controls: Map<string, { x: number; y: number; width: number; height: number }>,
): SemanticGroup[] {
  const textById = new Map(semanticText.map((node) => [node.id, node]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groups: SemanticGroup[] = [];
  for (const candidate of candidates) {
    if (!['horizontal', 'vertical'].includes(candidate.kind) || candidate.confidence < 0.85)
      continue;
    const container = nodeById.get(candidate.sourceNodeIds[0] ?? '');
    if (!container?.bounds) continue;
    const children = container.childIds.map((id) => textById.get(id));
    if (
      children.length < 2 ||
      children.some((node) => !node?.bounds || node.transform || controls.has(node.id))
    ) {
      continue;
    }
    const safeChildren = children as DesignBundleNode[];
    const direction = candidate.kind as 'horizontal' | 'vertical';
    const sorted = [...safeChildren].sort((left, right) =>
      direction === 'horizontal'
        ? left.bounds!.x - right.bounds!.x
        : left.bounds!.y - right.bounds!.y,
    );
    const gaps = sorted.slice(1).map((node, index) => {
      const previous = sorted[index]!;
      return direction === 'horizontal'
        ? node.bounds!.x - (previous.bounds!.x + previous.bounds!.width)
        : node.bounds!.y - (previous.bounds!.y + previous.bounds!.height);
    });
    groups.push({
      direction,
      bounds: container.bounds,
      gap: Math.max(0, gaps.reduce((sum, value) => sum + value, 0) / gaps.length),
      nodes: sorted,
    });
  }
  return groups;
}

function semanticGroupElement(group: SemanticGroup, width: number, height: number): string {
  const { bounds } = group;
  const style = `left:${decimal((bounds.x / width) * 100)}%;top:${decimal((bounds.y / height) * 100)}%;width:${decimal((bounds.width / width) * 100)}%;height:${decimal((bounds.height / height) * 100)}%;flex-direction:${group.direction === 'horizontal' ? 'row' : 'column'};gap:${decimal((group.gap / width) * 100)}cqw`;
  return `<div class="semantic-group" style="${style}">${group.nodes.map(semanticInlineElement).join('')}</div>`;
}

function semanticInlineElement(node: DesignBundleNode): string {
  const size = positiveNumber(node.computedStyle['font-size'], 16);
  const tag = size >= 32 ? 'h1' : size >= 24 ? 'h2' : 'p';
  const validationId = `svg-${createHash('sha256').update(node.id).digest('hex').slice(0, 16)}`;
  const color = safeCssValue(node.computedStyle['fill'] ?? '#000');
  const weight = safeCssValue(node.computedStyle['font-weight'] ?? '400');
  return `<${tag} class="semantic-node" data-validation-id="${validationId}" data-source-node-id="${escapeAttribute(node.id)}" style="font-size:${decimal(size)}px;color:${escapeAttribute(color)};font-weight:${escapeAttribute(weight)}">${escapeHtml(node.text ?? '')}</${tag}>`;
}

function cssVariables(values: Record<string, string[]>): string {
  const declarations: string[] = [];
  for (const [kind, entries] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
    entries.forEach((value, index) => {
      declarations.push(`\n  --svg-${cssName(kind)}-${index + 1}: ${safeCssValue(value)};`);
    });
  }
  return declarations.join('');
}

function safeCssValue(value: string): string {
  if (value.includes(';') || value.includes('{') || value.includes('}') || value.includes('\\')) {
    return 'inherit';
  }
  return value;
}

function cssName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function decimal(value: number): string {
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
