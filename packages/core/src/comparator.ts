import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { chromium } from 'playwright';
import { deltaE76 } from './color.js';
import type { Config } from './config.js';
import type { BrowserElementEvidence, BrowserEvidence } from './providers.js';
import {
  comparisonResultSchema,
  type ArtifactRef,
  type ComparisonResultRecord,
  type DesignContract,
  type DesignElement,
  type ValidationFinding,
} from './schemas.js';

export interface ComparisonResult extends ComparisonResultRecord {
  diff: Uint8Array | null;
  overlay: Uint8Array | null;
}

export interface ReferenceImage {
  bytes: Uint8Array;
  mediaType: string;
}

interface CheckState {
  total: number;
  passed: number;
}

export class SmartUiComparator {
  constructor(private readonly config: Config) {}

  async compare(
    contract: DesignContract,
    evidence: BrowserEvidence,
    reference: ReferenceImage | null,
    signal?: AbortSignal,
  ): Promise<ComparisonResult> {
    const findings: ValidationFinding[] = [];
    const state: CheckState = { total: 0, passed: 0 };
    const matchedBrowserIndices = new Set<number>();

    for (const designElement of contract.elements) {
      const browserIndex = findMatchingBrowserElement(
        designElement,
        evidence.elements,
        matchedBrowserIndices,
      );
      if (browserIndex === -1) {
        record(state, false);
        findings.push(
          finding({
            category: 'geometry',
            severity: 'error',
            confidence: 1,
            designElement,
            expected: designElement.validationId ?? designElement.selector ?? designElement.type,
            actual: null,
            message: `Design element '${designElement.validationId ?? designElement.selector ?? designElement.type}' is missing from the implementation.`,
            repair: 'missing_element',
            artifacts: [contract.reference],
          }),
        );
        continue;
      }
      matchedBrowserIndices.add(browserIndex);
      compareElementProperties(
        designElement,
        evidence.elements[browserIndex]!,
        this.config,
        findings,
        state,
        contract.reference,
      );
    }

    for (const [index, browserElement] of evidence.elements.entries()) {
      if (!matchedBrowserIndices.has(index) && browserElement.validationId) {
        record(state, false);
        findings.push(
          finding({
            category: 'geometry',
            severity: 'warning',
            confidence: 0.9,
            browserElement,
            expected: null,
            actual: browserElement.validationId,
            message: `Unexpected validation element '${browserElement.validationId}' exists in the implementation.`,
            repair: 'extra_element',
            artifacts: [contract.reference],
          }),
        );
      }
    }

    compareRuntime(evidence, this.config, findings, state, contract.reference);

    let diff: Uint8Array | null = null;
    let overlay: Uint8Array | null = null;
    let diffPercent = 0;
    if (!reference) {
      record(state, false);
      findings.push(
        finding({
          category: 'raster',
          severity: 'error',
          confidence: 1,
          expected: contract.reference.hash,
          actual: null,
          message:
            'The target raster artifact could not be read, so visual comparison was not verified.',
          repair: 'reference_unavailable',
          artifacts: [contract.reference],
        }),
      );
    } else if (evidence.screenshot.length === 0) {
      record(state, false);
      findings.push(
        finding({
          category: 'raster',
          severity: 'error',
          confidence: 1,
          expected: 'implementation screenshot',
          actual: null,
          message: 'The browser returned no implementation screenshot.',
          repair: 'screenshot_unavailable',
          artifacts: [contract.reference],
        }),
      );
    } else {
      try {
        const raster = await compareImages(
          reference.bytes,
          evidence.screenshot,
          [...this.config.masks, ...(evidence.dynamicRegions ?? [])],
          {
            channelTolerance: this.config.validation.rasterChannelTolerance,
            mediaType1: reference.mediaType,
            mediaType2: 'image/png',
            ...(signal ? { signal } : {}),
          },
        );
        diff = raster.diff;
        overlay = raster.overlay;
        diffPercent = raster.diffPercent;
        const passed = diffPercent <= this.config.validation.visualDifferencePercent;
        record(state, passed);
        if (!passed) {
          findings.push(
            finding({
              category: 'raster',
              severity: 'error',
              confidence: 0.95,
              expected: this.config.validation.visualDifferencePercent,
              actual: diffPercent,
              delta: diffPercent - this.config.validation.visualDifferencePercent,
              message: `Visual mismatch is ${diffPercent.toFixed(3)}%, above the ${this.config.validation.visualDifferencePercent}% threshold.`,
              repair: 'raster_difference',
              artifacts: [contract.reference],
            }),
          );
        }
      } catch (error) {
        record(state, false);
        findings.push(
          finding({
            category: 'raster',
            severity: 'error',
            confidence: 1,
            expected: contract.reference.mediaType,
            actual: error instanceof Error ? error.message : String(error),
            message: `Raster comparison failed: ${error instanceof Error ? error.message : String(error)}`,
            repair: 'raster_decode_failure',
            artifacts: [contract.reference],
          }),
        );
      }
    }

    const result = comparisonResultSchema.parse({
      schemaVersion: '1.0',
      score: state.total === 0 ? 100 : roundScore((state.passed / state.total) * 100),
      findings,
      diffPercent,
      checkedProperties: state.total,
      passedProperties: state.passed,
    });
    return { ...result, diff, overlay };
  }
}

function findMatchingBrowserElement(
  designElement: DesignElement,
  browserElements: BrowserElementEvidence[],
  matchedIndices: Set<number>,
): number {
  const availableIndex = (predicate: (element: BrowserElementEvidence) => boolean): number =>
    browserElements.findIndex((element, index) => !matchedIndices.has(index) && predicate(element));

  if (designElement.validationId) {
    return availableIndex((element) => element.validationId === designElement.validationId);
  }
  if (designElement.selector) {
    return availableIndex((element) => element.selector === designElement.selector);
  }
  const expectedType = normalizeElementType(designElement.type);
  const expectedText = designElement.text?.trim();
  return availableIndex((element) => {
    if (!typeMatches(expectedType, element.tagName, element.role)) return false;
    return expectedText ? normalizeText(element.text).includes(normalizeText(expectedText)) : true;
  });
}

function compareElementProperties(
  design: DesignElement,
  actual: BrowserElementEvidence,
  config: Config,
  findings: ValidationFinding[],
  state: CheckState,
  targetArtifact: ArtifactRef,
): void {
  const geometryTolerance = config.validation.geometryTolerancePx;
  const typographyTolerance = config.validation.typographyTolerancePx;
  const artifacts = [targetArtifact];

  compareNumber('geometry', 'x', design.x, actual.x, geometryTolerance, 'position', 'error');
  compareNumber('geometry', 'y', design.y, actual.y, geometryTolerance, 'position', 'error');
  compareNumber(
    'geometry',
    'width',
    design.width,
    actual.width,
    geometryTolerance,
    'size',
    'error',
  );
  compareNumber(
    'geometry',
    'height',
    design.height,
    actual.height,
    geometryTolerance,
    'size',
    'error',
  );
  compareEdges('padding', design.padding, actual.padding);
  compareEdges('margin', design.margin, actual.margin);
  compareNumber('geometry', 'gap', design.gap, actual.gap, geometryTolerance, 'gap', 'warning');
  compareString('geometry', 'alignItems', design.alignItems, actual.alignItems, 'alignment');
  compareString(
    'geometry',
    'justifyContent',
    design.justifyContent,
    actual.justifyContent,
    'alignment',
  );
  compareString('geometry', 'overflowX', design.overflowX, actual.overflowX, 'overflow');
  compareString('geometry', 'overflowY', design.overflowY, actual.overflowY, 'overflow');

  compareColor('color', design.color, actual.color);
  compareColor('backgroundColor', design.backgroundColor, actual.backgroundColor);
  compareColor('borderColor', design.borderColor, actual.borderColor);
  compareNumber(
    'appearance',
    'borderWidth',
    design.borderWidth,
    actual.borderWidth,
    geometryTolerance,
    'border',
    'warning',
  );
  compareNumber(
    'appearance',
    'borderRadius',
    design.borderRadius,
    actual.borderRadius,
    geometryTolerance,
    'border_radius',
    'warning',
  );
  compareNumber(
    'appearance',
    'opacity',
    design.opacity,
    actual.opacity,
    0.01,
    'opacity',
    'warning',
  );
  compareString('appearance', 'boxShadow', design.boxShadow, actual.boxShadow, 'shadow');

  compareString(
    'typography',
    'fontFamily',
    design.fontFamily,
    actual.fontFamily,
    'font_family',
    normalizeFontFamily,
  );
  compareString(
    'typography',
    'fontWeight',
    design.fontWeight,
    actual.fontWeight,
    'font_weight',
    normalizeFontWeight,
  );
  compareNumber(
    'typography',
    'fontSize',
    design.fontSize,
    actual.fontSize,
    typographyTolerance,
    'font_size',
    'error',
  );
  compareCssLength(
    'lineHeight',
    design.lineHeight,
    actual.lineHeight,
    typographyTolerance,
    'line_height',
  );
  compareCssLength(
    'letterSpacing',
    design.letterSpacing,
    actual.letterSpacing,
    typographyTolerance,
    'letter_spacing',
  );
  compareString('typography', 'text', design.text, actual.text, 'text_content', normalizeText);
  if (!config.validation.textWrapMismatchAllowed) {
    compareBoolean('typography', 'textWrap', design.textWrap, actual.textWrap, 'text_wrap');
    compareNumber(
      'typography',
      'lineCount',
      design.lineCount,
      actual.lineCount,
      0,
      'text_wrap',
      'warning',
    );
  }

  compareAssetSource(design.assetSource, actual.assetSource);
  compareNumber(
    'assets',
    'intrinsicWidth',
    design.intrinsicWidth,
    actual.intrinsicWidth,
    0,
    'asset_dimensions',
    'error',
  );
  compareNumber(
    'assets',
    'intrinsicHeight',
    design.intrinsicHeight,
    actual.intrinsicHeight,
    0,
    'asset_dimensions',
    'error',
  );
  compareString('assets', 'objectFit', design.objectFit, actual.objectFit, 'asset_crop');
  compareString(
    'assets',
    'objectPosition',
    design.objectPosition,
    actual.objectPosition,
    'asset_crop',
  );
  if (design.assetHash) {
    mismatch('assets', 'assetHash', design.assetHash, undefined, 'asset_hash', 'error', 1);
  }

  compareString('accessibility', 'role', design.role, actual.role, 'accessible_role');
  compareString(
    'accessibility',
    'accessibleName',
    design.accessibleName,
    actual.accessibleName,
    'accessible_name',
    normalizeText,
  );
  if (design.accessibleState) {
    compareString(
      'accessibility',
      'accessibleState',
      stableJson(design.accessibleState),
      stableJson(actual.accessibleState),
      'accessible_state',
    );
  }
  compareBoolean(
    'accessibility',
    'keyboardReachable',
    design.keyboardReachable,
    actual.keyboardReachable,
    'keyboard_nav',
  );
  compareBoolean(
    'accessibility',
    'focusVisible',
    design.focusVisible,
    actual.focusVisible,
    'focus_outline',
  );

  if (config.validation.requireKeyboardNavigation && isInteractiveRole(actual.role)) {
    requiredAccessibility('keyboardReachable', actual.keyboardReachable, 'keyboard_nav');
    if (actual.keyboardReachable)
      requiredAccessibility('focusVisible', actual.focusVisible, 'focus_outline');
    requiredAccessibility(
      'accessibleName',
      actual.accessibleName.trim().length > 0,
      'accessible_name',
    );
  }
  if (
    actual.text.trim().length > 0 &&
    actual.contrastRatio !== undefined &&
    actual.contrastRatio < config.validation.minimumContrastRatio
  ) {
    record(state, false);
    mismatch(
      'accessibility',
      'contrastRatio',
      config.validation.minimumContrastRatio,
      actual.contrastRatio,
      'color_contrast',
      'error',
      0.95,
      undefined,
      config.validation.minimumContrastRatio - actual.contrastRatio,
      false,
    );
  }

  function compareEdges(
    name: 'padding' | 'margin',
    expected: DesignElement[typeof name],
    observed: BrowserElementEvidence[typeof name],
  ): void {
    if (!expected) return;
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      compareNumber(
        'geometry',
        `${name}.${edge}`,
        expected[edge],
        observed[edge],
        geometryTolerance,
        name,
        'warning',
      );
    }
  }

  function compareColor(name: string, expected: string | undefined, observed: string): void {
    if (expected === undefined) return;
    let delta: number;
    try {
      delta = deltaE76(expected, observed);
    } catch (error) {
      mismatch(
        'appearance',
        name,
        expected,
        observed,
        'invalid_color',
        'error',
        1,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const passed = delta <= config.validation.colorDeltaE;
    record(state, passed);
    if (!passed)
      mismatch(
        'appearance',
        name,
        expected,
        observed,
        name,
        'error',
        0.95,
        undefined,
        delta,
        false,
      );
  }

  function compareAssetSource(expected: string | undefined, observed: string | undefined): void {
    if (expected === undefined) return;
    const normalizedExpected = normalizeAsset(expected);
    const normalizedObserved = observed ? normalizeAsset(observed) : undefined;
    const passed = normalizedExpected === normalizedObserved;
    record(state, passed);
    if (!passed)
      mismatch(
        'assets',
        'assetSource',
        expected,
        observed,
        'asset_selection',
        'error',
        0.95,
        undefined,
        undefined,
        false,
      );
  }

  function requiredAccessibility(name: string, passed: boolean, repair: string): void {
    record(state, passed);
    if (!passed)
      mismatch(
        'accessibility',
        name,
        true,
        false,
        repair,
        'error',
        0.95,
        undefined,
        undefined,
        false,
      );
  }

  function compareCssLength(
    name: string,
    expected: string | number | undefined,
    observed: string,
    tolerance: number,
    repair: string,
  ): void {
    if (expected === undefined) return;
    const expectedNumber = cssNumber(expected);
    const actualNumber = cssNumber(observed);
    if (expectedNumber !== null && actualNumber !== null) {
      compareNumber('typography', name, expectedNumber, actualNumber, tolerance, repair, 'warning');
    } else {
      compareString('typography', name, expected, observed, repair);
    }
  }

  function compareBoolean(
    category: ValidationFinding['category'],
    name: string,
    expected: boolean | undefined,
    observed: boolean,
    repair: string,
  ): void {
    if (expected === undefined) return;
    const passed = expected === observed;
    record(state, passed);
    if (!passed)
      mismatch(
        category,
        name,
        expected,
        observed,
        repair,
        'warning',
        0.9,
        undefined,
        undefined,
        false,
      );
  }

  function compareString(
    category: ValidationFinding['category'],
    name: string,
    expected: string | number | undefined,
    observed: string | number,
    repair: string,
    normalize: (value: string | number) => string = (value) => String(value).trim().toLowerCase(),
  ): void {
    if (expected === undefined) return;
    const passed = normalize(expected) === normalize(observed);
    record(state, passed);
    if (!passed)
      mismatch(
        category,
        name,
        expected,
        observed,
        repair,
        'warning',
        0.9,
        undefined,
        undefined,
        false,
      );
  }

  function compareNumber(
    category: ValidationFinding['category'],
    name: string,
    expected: number | undefined,
    observed: number | undefined,
    tolerance: number,
    repair: string,
    severity: ValidationFinding['severity'],
  ): void {
    if (expected === undefined) return;
    const delta = observed === undefined ? Number.POSITIVE_INFINITY : Math.abs(expected - observed);
    const passed = delta <= tolerance;
    record(state, passed);
    if (!passed)
      mismatch(category, name, expected, observed, repair, severity, 0.95, undefined, delta, false);
  }

  function mismatch(
    category: ValidationFinding['category'],
    name: string,
    expected: unknown,
    observed: unknown,
    repair: string,
    severity: ValidationFinding['severity'],
    confidence: number,
    extraMessage?: string,
    delta?: unknown,
    addCheck = true,
  ): void {
    if (addCheck) record(state, false);
    findings.push(
      finding({
        category,
        severity,
        confidence,
        designElement: design,
        browserElement: actual,
        expected,
        actual: observed,
        delta,
        message: `${name} mismatch: expected ${print(expected)}, actual ${print(observed)}.${extraMessage ? ` ${extraMessage}` : ''}`,
        repair,
        artifacts,
      }),
    );
  }
}

function compareRuntime(
  evidence: BrowserEvidence,
  config: Config,
  findings: ValidationFinding[],
  state: CheckState,
  artifact: ArtifactRef,
): void {
  if (config.validation.requireNoConsoleErrors) {
    const passed = evidence.consoleErrors.length === 0;
    record(state, passed);
    for (const error of evidence.consoleErrors) {
      findings.push(
        finding({
          category: 'runtime',
          severity: 'error',
          confidence: 1,
          expected: 'no console errors',
          actual: error,
          message: `Browser console error: ${error}`,
          repair: 'console_error',
          artifacts: [artifact],
        }),
      );
    }
  }
  if (config.validation.requireNoNetworkFailures) {
    const passed = evidence.failedRequests.length === 0;
    record(state, passed);
    for (const request of evidence.failedRequests) {
      findings.push(
        finding({
          category: 'runtime',
          severity: 'error',
          confidence: 1,
          expected: 'no failed requests',
          actual: request,
          message: `Failed network request: ${request}`,
          repair: 'network_failure',
          artifacts: [artifact],
        }),
      );
    }
  }
  for (const violation of evidence.accessibilityViolations ?? []) {
    if (violation.rule === 'accessible-name' && !config.validation.requireAccessibleNames) continue;
    record(state, false);
    const browserElement = evidence.elements.find(
      (element) => element.selector === violation.selector,
    );
    findings.push(
      finding({
        category: 'accessibility',
        severity: 'error',
        confidence: 1,
        expected: `no ${violation.rule} violations`,
        actual: violation.message,
        message: `${violation.rule}: ${violation.message}`,
        repair: violation.rule,
        artifacts: [artifact],
        ...(browserElement ? { browserElement } : {}),
      }),
    );
  }
}

interface FindingInput {
  category: ValidationFinding['category'];
  severity: ValidationFinding['severity'];
  confidence: number;
  designElement?: DesignElement;
  browserElement?: BrowserElementEvidence;
  expected?: unknown;
  actual?: unknown;
  delta?: unknown;
  message: string;
  repair?: string;
  artifacts: ArtifactRef[];
}

function finding(input: FindingInput): ValidationFinding {
  const designNodeId = input.designElement?.figmaNodeId;
  const sourceNodeId = input.designElement?.sourceNodeId;
  const targetDomLocator = input.browserElement?.validationId ?? input.browserElement?.selector;
  const id = createHash('sha256')
    .update(
      stableJson({
        category: input.category,
        designNodeId,
        sourceNodeId,
        targetDomLocator,
        expected: input.expected,
        actual: input.actual,
        repair: input.repair,
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return {
    id: `finding-${id}`,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence,
    ...(designNodeId ? { designNodeId } : {}),
    ...(sourceNodeId ? { sourceNodeId } : {}),
    ...(targetDomLocator ? { targetDomLocator } : {}),
    ...(input.expected !== undefined ? { expected: input.expected } : {}),
    ...(input.actual !== undefined ? { actual: input.actual } : {}),
    ...(input.delta !== undefined && Number.isFinite(input.delta as number)
      ? { delta: input.delta }
      : {}),
    message: input.message,
    ...(input.repair ? { suggestedRepairCategory: input.repair } : {}),
    evidenceArtifacts: input.artifacts,
  };
}

export async function compareImages(
  image1: Uint8Array,
  image2: Uint8Array,
  masks: Array<{ x: number; y: number; width: number; height: number }> = [],
  options: {
    channelTolerance?: number;
    mediaType1?: string;
    mediaType2?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ diffPercent: number; diff: Uint8Array; heatmap: Uint8Array; overlay: Uint8Array }> {
  const browser = await chromium.launch({ headless: true });
  const cancel = () => void browser.close();
  if (options.signal?.aborted) {
    await browser.close();
    throw new Error('Image comparison was canceled.');
  }
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(
      async ({ first, second, firstType, secondType, maskList, tolerance }) => {
        const load = (source: string): Promise<HTMLImageElement> =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Image decode failed.'));
            image.src = source;
          });
        const [target, implementation] = await Promise.all([
          load(`data:${firstType};base64,${first}`),
          load(`data:${secondType};base64,${second}`),
        ]);
        const width = Math.max(target.width, implementation.width);
        const height = Math.max(target.height, implementation.height);
        if (width === 0 || height === 0) throw new Error('Image has zero dimensions.');
        const canvas = () => {
          const value = document.createElement('canvas');
          value.width = width;
          value.height = height;
          return value;
        };
        const targetCanvas = canvas();
        const implementationCanvas = canvas();
        const diffCanvas = canvas();
        const overlayCanvas = canvas();
        const targetContext = targetCanvas.getContext('2d')!;
        const implementationContext = implementationCanvas.getContext('2d')!;
        const diffContext = diffCanvas.getContext('2d')!;
        const overlayContext = overlayCanvas.getContext('2d')!;
        targetContext.drawImage(target, 0, 0);
        implementationContext.drawImage(implementation, 0, 0);
        const targetData = targetContext.getImageData(0, 0, width, height);
        const implementationData = implementationContext.getImageData(0, 0, width, height);
        const diffData = diffContext.createImageData(width, height);
        let different = 0;
        let compared = 0;
        for (let pixel = 0; pixel < width * height; pixel++) {
          const offset = pixel * 4;
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          const masked = maskList.some(
            (mask) =>
              x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height,
          );
          if (masked) {
            diffData.data[offset] = implementationData.data[offset]!;
            diffData.data[offset + 1] = implementationData.data[offset + 1]!;
            diffData.data[offset + 2] = implementationData.data[offset + 2]!;
            diffData.data[offset + 3] = 50;
            continue;
          }
          compared++;
          const channelDiffs = [0, 1, 2, 3].map((channel) =>
            Math.abs(
              targetData.data[offset + channel]! - implementationData.data[offset + channel]!,
            ),
          );
          const differs = channelDiffs.some((difference) => difference > tolerance);
          if (differs) different++;
          diffData.data[offset] = differs ? 255 : implementationData.data[offset]!;
          diffData.data[offset + 1] = differs ? 0 : implementationData.data[offset + 1]!;
          diffData.data[offset + 2] = differs ? 0 : implementationData.data[offset + 2]!;
          diffData.data[offset + 3] = differs ? 255 : 90;
        }
        diffContext.putImageData(diffData, 0, 0);
        overlayContext.globalAlpha = 0.5;
        overlayContext.drawImage(targetCanvas, 0, 0);
        overlayContext.drawImage(implementationCanvas, 0, 0);
        return {
          diffPercent: compared === 0 ? 0 : (different / compared) * 100,
          diffUrl: diffCanvas.toDataURL('image/png'),
          overlayUrl: overlayCanvas.toDataURL('image/png'),
        };
      },
      {
        first: Buffer.from(image1).toString('base64'),
        second: Buffer.from(image2).toString('base64'),
        firstType: options.mediaType1 ?? 'image/png',
        secondType: options.mediaType2 ?? 'image/png',
        maskList: masks,
        tolerance: options.channelTolerance ?? 10,
      },
    );
    const diff = decodeDataUrl(result.diffUrl);
    return {
      diffPercent: result.diffPercent,
      diff,
      heatmap: diff,
      overlay: decodeDataUrl(result.overlayUrl),
    };
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await browser.close();
  }
}

function record(state: CheckState, passed: boolean): void {
  state.total++;
  if (passed) state.passed++;
}

function normalizeElementType(type: string): string {
  return type
    .trim()
    .toLowerCase()
    .replace(/^figma:/, '');
}

function typeMatches(expected: string, tagName: string, role: string): boolean {
  if (expected === tagName || expected === role) return true;
  if (['frame', 'group', 'component', 'instance'].includes(expected)) {
    return ['div', 'section', 'article', 'main', 'header', 'footer', 'nav'].includes(tagName);
  }
  if (expected === 'text') return !['img', 'svg', 'video', 'canvas'].includes(tagName);
  if (expected === 'rectangle') return ['div', 'section', 'article'].includes(tagName);
  return false;
}

function normalizeText(value: string | number): string {
  return String(value).trim().replace(/\s+/g, ' ');
}

function normalizeFontFamily(value: string | number): string {
  return String(value)
    .split(',')
    .map((family) =>
      family
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .toLowerCase(),
    )
    .join(',');
}

function normalizeFontWeight(value: string | number): string {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'normal') return '400';
  if (normalized === 'bold') return '700';
  return normalized;
}

function normalizeAsset(value: string): string {
  try {
    return basename(new URL(value).pathname);
  } catch {
    return basename(value);
  }
}

function cssNumber(value: string | number): number | null {
  if (typeof value === 'number') return value;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isInteractiveRole(role: string): boolean {
  return [
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'menuitem',
    'switch',
  ].includes(role);
}

function print(value: unknown): string {
  return value === undefined ? 'unavailable' : stableJson(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function decodeDataUrl(value: string): Uint8Array {
  const encoded = value.split(',')[1];
  if (!encoded) throw new Error('Canvas did not return image data.');
  return Uint8Array.from(Buffer.from(encoded, 'base64'));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
