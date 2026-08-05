import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import type { DesignContract, DesignElement, ValidationFinding } from './schemas.js';
import type { BrowserEvidence, BrowserElementEvidence } from './providers.js';
import type { Config } from './config.js';
import { deltaE76 } from './color.js';

export interface ComparisonResult {
  score: number;
  findings: ValidationFinding[];
  heatmap: Uint8Array | null;
  diffPercent: number;
}

export class SmartUiComparator {
  constructor(private readonly config: Config) {}

  async compare(
    contract: DesignContract,
    evidence: BrowserEvidence,
    referencePng: Uint8Array | null,
  ): Promise<ComparisonResult> {
    const findings: ValidationFinding[] = [];
    let totalChecks = 0;
    let passedChecks = 0;

    const recordCheck = (passed: boolean) => {
      totalChecks++;
      if (passed) passedChecks++;
    };

    const designElements = contract.elements;
    const browserElements = evidence.elements;

    const matchedBrowserIndices = new Set<number>();

    for (const designEl of designElements) {
      const browserElIdx = findMatchingBrowserElement(designEl, browserElements, matchedBrowserIndices);

      if (browserElIdx === -1) {
        findings.push({
          id: randomUUID(),
          category: 'geometry',
          severity: 'error',
          confidence: 1.0,
          designNodeId: designEl.figmaNodeId,
          message: `Design element '${designEl.validationId || designEl.selector || designEl.type}' is missing from the implementation.`,
          suggestedRepairCategory: 'missing_element',
        });
        recordCheck(false);
        continue;
      }

      matchedBrowserIndices.add(browserElIdx);
      const browserEl = browserElements[browserElIdx]!;

      compareElementProperties(designEl, browserEl, this.config, findings, recordCheck);
    }

    for (let i = 0; i < browserElements.length; i++) {
      if (!matchedBrowserIndices.has(i)) {
        const extraEl = browserElements[i]!;
        if (extraEl.validationId) {
          findings.push({
            id: randomUUID(),
            category: 'geometry',
            severity: 'warning',
            confidence: 0.8,
            targetDomLocator: extraEl.validationId || extraEl.selector,
            message: `Unexpected element '${extraEl.validationId || extraEl.selector}' found in the implementation.`,
            suggestedRepairCategory: 'extra_element',
          });
        }
      }
    }

    if (this.config.validation.requireNoConsoleErrors && evidence.consoleErrors.length > 0) {
      for (const err of evidence.consoleErrors) {
        findings.push({
          id: randomUUID(),
          category: 'runtime',
          severity: 'error',
          confidence: 1.0,
          message: `Browser console error: ${err}`,
        });
        recordCheck(false);
      }
    } else {
      recordCheck(true);
    }

    if (evidence.failedRequests.length > 0) {
      for (const req of evidence.failedRequests) {
        findings.push({
          id: randomUUID(),
          category: 'runtime',
          severity: 'error',
          confidence: 1.0,
          message: `Failed network request: ${req}`,
        });
        recordCheck(false);
      }
    } else {
      recordCheck(true);
    }

    let heatmap: Uint8Array | null = null;
    let diffPercent = 0;

    if (referencePng && evidence.screenshot.length > 0) {
      try {
        const rasterDiff = await compareImages(
          referencePng,
          evidence.screenshot,
          this.config.masks,
        );
        heatmap = rasterDiff.heatmap;
        diffPercent = rasterDiff.diffPercent;

        const visualDiffPercentThreshold = this.config.validation.visualDifferencePercent;
        if (diffPercent > visualDiffPercentThreshold) {
          findings.push({
            id: randomUUID(),
            category: 'raster',
            severity: 'error',
            confidence: 0.9,
            message: `Visual pixel mismatch is ${diffPercent.toFixed(2)}%, exceeding threshold of ${visualDiffPercentThreshold}%.`,
            expected: visualDiffPercentThreshold,
            actual: diffPercent,
            delta: diffPercent - visualDiffPercentThreshold,
          });
          recordCheck(false);
        } else {
          recordCheck(true);
        }
      } catch (err) {
        findings.push({
          id: randomUUID(),
          category: 'raster',
          severity: 'warning',
          confidence: 0.5,
          message: `Failed to calculate raster comparison: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const score = totalChecks > 0 ? Math.max(0, Math.min(100, Math.round((passedChecks / totalChecks) * 100))) : 100;

    return {
      score,
      findings,
      heatmap,
      diffPercent,
    };
  }
}

function findMatchingBrowserElement(
  designEl: DesignElement,
  browserElements: BrowserElementEvidence[],
  matchedIndices: Set<number>,
): number {
  if (designEl.validationId) {
    const idx = browserElements.findIndex((el) => el.validationId === designEl.validationId);
    if (idx !== -1) return idx;
  }

  if (designEl.selector) {
    const idx = browserElements.findIndex((el) => el.selector === designEl.selector);
    if (idx !== -1 && !matchedIndices.has(idx)) return idx;
  }

  for (let i = 0; i < browserElements.length; i++) {
    if (matchedIndices.has(i)) continue;
    const bEl = browserElements[i]!;
    if (bEl.tagName === designEl.type && (bEl.text || '').includes(designEl.text || '')) {
      return i;
    }
  }

  return -1;
}

function compareElementProperties(
  designEl: DesignElement,
  browserEl: BrowserElementEvidence,
  config: Config,
  findings: ValidationFinding[],
  recordCheck: (passed: boolean) => void,
) {
  const locator = browserEl.validationId || browserEl.selector;
  const geomTol = config.validation.geometryTolerancePx;

  if (designEl.x !== undefined && designEl.y !== undefined) {
    const xDiff = Math.abs(designEl.x - browserEl.x);
    const yDiff = Math.abs(designEl.y - browserEl.y);
    const geomOk = xDiff <= geomTol && yDiff <= geomTol;
    recordCheck(geomOk);
    if (!geomOk) {
      findings.push({
        id: randomUUID(),
        category: 'geometry',
        severity: 'error',
        confidence: 0.95,
        designNodeId: designEl.figmaNodeId,
        targetDomLocator: locator,
        expected: { x: designEl.x, y: designEl.y },
        actual: { x: browserEl.x, y: browserEl.y },
        delta: Math.max(xDiff, yDiff),
        message: `Element geometry position mismatch: expected (${designEl.x}, ${designEl.y}), actual (${browserEl.x}, ${browserEl.y}).`,
        suggestedRepairCategory: 'position',
      });
    }
  }

  if (designEl.width !== undefined && designEl.height !== undefined) {
    const wDiff = Math.abs(designEl.width - browserEl.width);
    const hDiff = Math.abs(designEl.height - browserEl.height);
    const sizeOk = wDiff <= geomTol && hDiff <= geomTol;
    recordCheck(sizeOk);
    if (!sizeOk) {
      findings.push({
        id: randomUUID(),
        category: 'geometry',
        severity: 'error',
        confidence: 0.95,
        designNodeId: designEl.figmaNodeId,
        targetDomLocator: locator,
        expected: { width: designEl.width, height: designEl.height },
        actual: { width: browserEl.width, height: browserEl.height },
        delta: Math.max(wDiff, hDiff),
        message: `Element geometry size mismatch: expected ${designEl.width}x${designEl.height}, actual ${browserEl.width}x${browserEl.height}.`,
        suggestedRepairCategory: 'size',
      });
    }
  }

  if (designEl.backgroundColor) {
    const dE = deltaE76(designEl.backgroundColor, browserEl.backgroundColor);
    const bgOk = dE <= config.validation.colorDeltaE;
    recordCheck(bgOk);
    if (!bgOk) {
      findings.push({
        id: randomUUID(),
        category: 'appearance',
        severity: 'error',
        confidence: 0.9,
        designNodeId: designEl.figmaNodeId,
        targetDomLocator: locator,
        expected: designEl.backgroundColor,
        actual: browserEl.backgroundColor,
        delta: dE,
        message: `Element background color mismatch (Delta E: ${dE.toFixed(2)}): expected '${designEl.backgroundColor}', actual '${browserEl.backgroundColor}'.`,
        suggestedRepairCategory: 'background_color',
      });
    }
  }

  if (designEl.color) {
    const dE = deltaE76(designEl.color, browserEl.color);
    const colorOk = dE <= config.validation.colorDeltaE;
    recordCheck(colorOk);
    if (!colorOk) {
      findings.push({
        id: randomUUID(),
        category: 'appearance',
        severity: 'error',
        confidence: 0.9,
        designNodeId: designEl.figmaNodeId,
        targetDomLocator: locator,
        expected: designEl.color,
        actual: browserEl.color,
        delta: dE,
        message: `Element text color mismatch (Delta E: ${dE.toFixed(2)}): expected '${designEl.color}', actual '${browserEl.color}'.`,
        suggestedRepairCategory: 'text_color',
      });
    }
  }

  if (designEl.borderRadius !== undefined) {
    const rOk = Math.abs(designEl.borderRadius - browserEl.borderRadius) <= 1;
    recordCheck(rOk);
    if (!rOk) {
      findings.push({
        id: randomUUID(),
        category: 'appearance',
        severity: 'warning',
        confidence: 0.8,
        designNodeId: designEl.figmaNodeId,
        targetDomLocator: locator,
        expected: designEl.borderRadius,
        actual: browserEl.borderRadius,
        delta: Math.abs(designEl.borderRadius - browserEl.borderRadius),
        message: `Element border radius mismatch: expected ${designEl.borderRadius}px, actual ${browserEl.borderRadius}px.`,
        suggestedRepairCategory: 'border_radius',
      });
    }
  }

  if (designEl.fontSize !== undefined) {
    const fsOk = Math.abs(designEl.fontSize - browserEl.fontSize) <= 1;
    recordCheck(fsOk);
    if (!fsOk) {
      findings.push({
        id: randomUUID(),
        category: 'typography',
        severity: 'error',
        confidence: 0.9,
        designNodeId: designEl.figmaNodeId,
        targetDomLocator: locator,
        expected: designEl.fontSize,
        actual: browserEl.fontSize,
        delta: Math.abs(designEl.fontSize - browserEl.fontSize),
        message: `Element font size mismatch: expected ${designEl.fontSize}px, actual ${browserEl.fontSize}px.`,
        suggestedRepairCategory: 'font_size',
      });
    }
  }

  if (designEl.textWrap !== undefined && !config.validation.textWrapMismatchAllowed) {
    const wrapOk = designEl.textWrap === browserEl.textWrap;
    recordCheck(wrapOk);
    if (!wrapOk) {
      findings.push({
        id: randomUUID(),
        category: 'typography',
        severity: 'warning',
        confidence: 0.8,
        designNodeId: designEl.figmaNodeId,
        targetDomLocator: locator,
        expected: designEl.textWrap,
        actual: browserEl.textWrap,
        message: `Element text wrapping mismatch: expected textWrap=${designEl.textWrap}, actual textWrap=${browserEl.textWrap}.`,
        suggestedRepairCategory: 'text_wrap',
      });
    }
  }

  if (config.validation.requireKeyboardNavigation) {
    const isInteractive = ['button', 'link', 'textbox', 'checkbox', 'radio'].includes(browserEl.role);
    if (isInteractive) {
      const krOk = browserEl.keyboardReachable;
      recordCheck(krOk);
      if (!krOk) {
        findings.push({
          id: randomUUID(),
          category: 'accessibility',
          severity: 'error',
          confidence: 0.9,
          designNodeId: designEl.figmaNodeId,
          targetDomLocator: locator,
          message: `Interactive element of role '${browserEl.role}' is not keyboard reachable (missing tabIndex or disabled).`,
          suggestedRepairCategory: 'keyboard_nav',
        });
      }

      if (krOk) {
        const fvOk = browserEl.focusVisible;
        recordCheck(fvOk);
        if (!fvOk) {
          findings.push({
            id: randomUUID(),
            category: 'accessibility',
            severity: 'warning',
            confidence: 0.8,
            designNodeId: designEl.figmaNodeId,
            targetDomLocator: locator,
            message: `Keyboard reachable element has no visible outline on focus.`,
            suggestedRepairCategory: 'focus_outline',
          });
        }
      }
    }
  }
}

export async function compareImages(
  imgBuffer1: Uint8Array,
  imgBuffer2: Uint8Array,
  masks: Array<{ x: number; y: number; width: number; height: number }> = [],
): Promise<{ diffPercent: number; heatmap: Uint8Array }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const base64_1 = Buffer.from(imgBuffer1).toString('base64');
    const base64_2 = Buffer.from(imgBuffer2).toString('base64');

    const result = await page.evaluate(
      async ({ b1, b2, masksList }) => {
        const loadImage = (src: string): Promise<HTMLImageElement> => {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
          });
        };

        const img1 = await loadImage(`data:image/png;base64,${b1}`);
        const img2 = await loadImage(`data:image/png;base64,${b2}`);

        const width = Math.max(img1.width, img2.width);
        const height = Math.max(img1.height, img2.height);

        const c1 = document.createElement('canvas');
        const c2 = document.createElement('canvas');
        const cDiff = document.createElement('canvas');

        c1.width = c2.width = cDiff.width = width;
        c1.height = c2.height = cDiff.height = height;

        const ctx1 = c1.getContext('2d')!;
        const ctx2 = c2.getContext('2d')!;
        const ctxDiff = cDiff.getContext('2d')!;

        ctx1.drawImage(img1, 0, 0);
        ctx2.drawImage(img2, 0, 0);

        const d1 = ctx1.getImageData(0, 0, width, height);
        const d2 = ctx2.getImageData(0, 0, width, height);
        const dDiff = ctxDiff.createImageData(width, height);

        let diffPixels = 0;
        const totalPixels = width * height;

        const isMasked = (x: number, y: number) => {
          return masksList.some(
            (m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height,
          );
        };

        for (let i = 0; i < totalPixels; i++) {
          const idx = i * 4;
          const x = i % width;
          const y = Math.floor(i / width);

          if (isMasked(x, y)) {
            dDiff.data[idx] = d2.data[idx]!;
            dDiff.data[idx + 1] = d2.data[idx + 1]!;
            dDiff.data[idx + 2] = d2.data[idx + 2]!;
            dDiff.data[idx + 3] = 80;
            continue;
          }

          const rDiff = Math.abs(d1.data[idx]! - d2.data[idx]!);
          const gDiff = Math.abs(d1.data[idx + 1]! - d2.data[idx + 1]!);
          const bDiff = Math.abs(d1.data[idx + 2]! - d2.data[idx + 2]!);
          const aDiff = Math.abs(d1.data[idx + 3]! - d2.data[idx + 3]!);

          if (rDiff > 10 || gDiff > 10 || bDiff > 10 || aDiff > 10) {
            diffPixels++;
            dDiff.data[idx] = 255;
            dDiff.data[idx + 1] = 0;
            dDiff.data[idx + 2] = 0;
            dDiff.data[idx + 3] = 255;
          } else {
            dDiff.data[idx] = d2.data[idx]!;
            dDiff.data[idx + 1] = d2.data[idx + 1]!;
            dDiff.data[idx + 2] = d2.data[idx + 2]!;
            dDiff.data[idx + 3] = 100;
          }
        }

        ctxDiff.putImageData(dDiff, 0, 0);

        return {
          diffPercent: (diffPixels / totalPixels) * 100,
          heatmapUrl: cDiff.toDataURL('image/png'),
        };
      },
      { b1: base64_1, b2: base64_2, masksList: masks },
    );

    const parts = result.heatmapUrl.split(',');
    const base64Heatmap = parts[1] || '';
    return {
      diffPercent: result.diffPercent,
      heatmap: Uint8Array.from(Buffer.from(base64Heatmap, 'base64')),
    };
  } finally {
    await browser.close();
  }
}
