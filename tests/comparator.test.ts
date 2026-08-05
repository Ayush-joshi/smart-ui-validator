import { describe, expect, it } from 'vitest';
import { SmartUiComparator, compareImages, configSchema } from '../packages/core/src/index.js';
import { browserElement, contract, designElement, evidence, PNG_BYTES } from './helpers.js';

const reference = {
  hash: 'sha256:47f0c7e227f7d2e0e9a5e43f42f36f8f52dc958d68e1f559b6e4c6f52f62e7e1',
  mediaType: 'image/png',
  relativePath: 'objects/47/reference.png',
  byteLength: PNG_BYTES.byteLength,
};

const comparator = new SmartUiComparator(configSchema.parse({}));

describe('deterministic comparison engine', () => {
  it('scores every supported property at 100 when evidence matches', async () => {
    const design = designElement({
      padding: { top: 1, right: 2, bottom: 3, left: 4 },
      margin: { top: 4, right: 3, bottom: 2, left: 1 },
      gap: 8,
      alignItems: 'center',
      justifyContent: 'space-between',
      overflowX: 'hidden',
      overflowY: 'auto',
      color: '#000000',
      backgroundColor: 'transparent',
      borderColor: '#000000',
      borderWidth: 1,
      borderRadius: 4,
      opacity: 0.5,
      boxShadow: 'none',
      fontFamily: 'Arial',
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 24,
      letterSpacing: 0,
      text: 'Hello',
      textWrap: false,
      lineCount: 1,
      assetSource: '/assets/logo.png',
      intrinsicWidth: 20,
      intrinsicHeight: 10,
      objectFit: 'contain',
      objectPosition: '50% 50%',
      role: 'button',
      accessibleName: 'Hello',
      accessibleState: { pressed: false },
      keyboardReachable: true,
      focusVisible: true,
    });
    const actual = browserElement({
      tagName: 'button',
      padding: { top: 1, right: 2, bottom: 3, left: 4 },
      margin: { top: 4, right: 3, bottom: 2, left: 1 },
      gap: 8,
      alignItems: 'center',
      justifyContent: 'space-between',
      overflowX: 'hidden',
      overflowY: 'auto',
      opacity: 0.5,
      borderWidth: 1,
      borderRadius: 4,
      assetSource: 'http://127.0.0.1/assets/logo.png',
      intrinsicWidth: 20,
      intrinsicHeight: 10,
      objectFit: 'contain',
      role: 'button',
      accessibleState: { pressed: false },
      keyboardReachable: true,
      focusVisible: true,
    });
    const result = await comparator.compare(contract(reference, [design]), evidence([actual]), {
      bytes: PNG_BYTES,
      mediaType: 'image/png',
    });
    expect(result.score).toBe(100);
    expect(result.findings).toEqual([]);
    expect(result.schemaVersion).toBe('1.0');
    expect(result.checkedProperties).toBeGreaterThan(30);
  });

  it.each([
    [
      'geometry',
      designElement({ padding: { top: 9, right: 0, bottom: 0, left: 0 } }),
      browserElement(),
    ],
    ['typography', designElement({ fontFamily: 'Inter' }), browserElement()],
    ['appearance', designElement({ opacity: 0 }), browserElement()],
    [
      'assets',
      designElement({ assetSource: '/wanted.png' }),
      browserElement({ assetSource: '/actual.png' }),
    ],
    ['accessibility', designElement({ role: 'button' }), browserElement({ role: 'generic' })],
  ])('localizes a %s mismatch', async (category, design, actual) => {
    const result = await comparator.compare(contract(reference, [design]), evidence([actual]), {
      bytes: PNG_BYTES,
      mediaType: 'image/png',
    });
    expect(result.findings.some((finding) => finding.category === category)).toBe(true);
    expect(result.findings.every((finding) => finding.evidenceArtifacts.length > 0)).toBe(true);
  });

  it('honors threshold boundaries and stable finding ids', async () => {
    const boundary = await comparator.compare(
      contract(reference, [designElement({ x: 12 })]),
      evidence(),
      { bytes: PNG_BYTES, mediaType: 'image/png' },
    );
    expect(
      boundary.findings.some((finding) => finding.suggestedRepairCategory === 'position'),
    ).toBe(false);
    const first = await comparator.compare(
      contract(reference, [designElement({ x: 12.01 })]),
      evidence(),
      { bytes: PNG_BYTES, mediaType: 'image/png' },
    );
    const second = await comparator.compare(
      contract(reference, [designElement({ x: 12.01 })]),
      evidence(),
      { bytes: PNG_BYTES, mediaType: 'image/png' },
    );
    expect(first.findings[0]?.id).toBe(second.findings[0]?.id);
  });

  it('detects missing, extra, console, and network failures', async () => {
    const result = await comparator.compare(
      contract(reference, [designElement({ validationId: 'missing' })]),
      evidence([browserElement({ validationId: 'extra' })], {
        consoleErrors: ['boom'],
        failedRequests: ['https://example.test/api?token=[REDACTED]: HTTP 500'],
      }),
      { bytes: PNG_BYTES, mediaType: 'image/png' },
    );
    expect(
      result.findings.some((finding) => finding.suggestedRepairCategory === 'missing_element'),
    ).toBe(true);
    expect(
      result.findings.some((finding) => finding.suggestedRepairCategory === 'extra_element'),
    ).toBe(true);
    expect(result.findings.filter((finding) => finding.category === 'runtime')).toHaveLength(2);
    expect(result.score).toBeLessThan(100);
  });

  it('fails scoring when raster evidence cannot be decoded', async () => {
    const result = await comparator.compare(
      contract(reference, []),
      evidence([], { screenshot: PNG_BYTES }),
      {
        bytes: new TextEncoder().encode('not an image'),
        mediaType: 'image/png',
      },
    );
    expect(
      result.findings.some(
        (finding) => finding.suggestedRepairCategory === 'raster_decode_failure',
      ),
    ).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it('supports SVG raster comparison and excludes approved masks from the denominator', async () => {
    const red = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
    );
    const blue = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="blue"/></svg>',
    );
    const different = await compareImages(red, blue, [], {
      mediaType1: 'image/svg+xml',
      mediaType2: 'image/svg+xml',
    });
    expect(different.diffPercent).toBe(100);
    const masked = await compareImages(red, blue, [{ x: 0, y: 0, width: 4, height: 4 }], {
      mediaType1: 'image/svg+xml',
      mediaType2: 'image/svg+xml',
    });
    expect(masked.diffPercent).toBe(0);
  });
});
