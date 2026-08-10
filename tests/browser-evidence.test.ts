import { describe, expect, it } from 'vitest';
import { PlaywrightBrowserProvider, compareImages } from '../packages/core/src/index.js';

describe('deterministic browser evidence', () => {
  it('preserves zero values, measures wrapping/focus, and blocks external requests', async () => {
    const html = `<html lang="en"><style>button:hover{background:rgb(1, 2, 3)}button:focus-visible{outline:3px solid blue}.wrap{width:30px}</style>
      <div id="zero" style="opacity:0;display:flex;gap:0">hidden</div>
      <div id="wrap" class="wrap" data-smart-ui-dynamic>one two three</div>
      <button data-validation-id="action">Go</button>
      <img src="https://blocked.test/private.png?token=secret"></html>`;
    const result = await new PlaywrightBrowserProvider().capture({
      url: `data:text/html,${encodeURIComponent(html)}`,
      viewport: { width: 320, height: 240, deviceScaleFactor: 1 },
      timeoutMs: 5_000,
      locale: 'en-US',
      theme: 'light',
      allowedEndpoints: [],
      blockExternalNetwork: true,
      interaction: { name: 'hover', selector: '[data-validation-id="action"]' },
      dynamicRegionSelectors: ['#wrap'],
      evidenceLimits: {
        maxElements: 100,
        maxTextLength: 1_000,
        maxConsoleMessages: 20,
        maxFailedRequests: 20,
        maxArtifactBytes: 1_000_000,
      },
    });
    expect(result.elements.find((element) => element.selector === '#zero')).toMatchObject({
      opacity: 0,
      gap: 0,
    });
    expect(
      result.elements.find((element) => element.selector === '#wrap')?.lineCount,
    ).toBeGreaterThan(1);
    expect(result.elements.find((element) => element.validationId === 'action')).toMatchObject({
      role: 'button',
      keyboardReachable: true,
      focusVisible: true,
    });
    expect(result.failedRequests).toHaveLength(1);
    expect(result.failedRequests[0]).not.toContain('secret');
    expect(result.interactionState).toBe('hover');
    expect(result.dynamicRegions).toHaveLength(1);
    expect(
      result.elements.find((element) => element.validationId === 'action')?.backgroundColor,
    ).toBe('rgb(1, 2, 3)');
    expect(result.accessibilityViolations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'image-alt' })]),
    );
  });

  it('rejects unapproved dynamic regions instead of silently masking them', async () => {
    const html = '<html lang="en"><div data-smart-ui-dynamic>clock</div></html>';
    await expect(
      new PlaywrightBrowserProvider().capture({
        url: `data:text/html,${encodeURIComponent(html)}`,
        viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
        timeoutMs: 5_000,
        locale: 'en-US',
        theme: 'light',
        allowedEndpoints: [],
        blockExternalNetwork: true,
        evidenceLimits: {
          maxElements: 100,
          maxTextLength: 1_000,
          maxConsoleMessages: 20,
          maxFailedRequests: 20,
          maxArtifactBytes: 1_000_000,
        },
      }),
    ).rejects.toThrow(/explicit masking policy/);
  });

  it('keeps generation default-state screenshots separate from focus probing without changing validation defaults', async () => {
    const html = `<html lang="en"><style>body{margin:0;background:#fff}button{width:100px;height:100px}button:focus-visible{outline:3px solid #00f}</style><button>Focus target</button><script>document.querySelector('button').addEventListener('focus',()=>document.body.style.background='#f00')</script></html>`;
    const provider = new PlaywrightBrowserProvider();
    const options = {
      url: `data:text/html,${encodeURIComponent(html)}`,
      viewport: { width: 120, height: 120, deviceScaleFactor: 1 },
      timeoutMs: 5_000,
      locale: 'en-US',
      theme: 'light' as const,
      allowedEndpoints: [],
      blockExternalNetwork: true,
      evidenceLimits: {
        maxElements: 100,
        maxTextLength: 1_000,
        maxConsoleMessages: 20,
        maxFailedRequests: 20,
        maxArtifactBytes: 1_000_000,
      },
    };
    const generation = await provider.capture({ ...options, screenshotBeforeFocusProbe: true });
    const validation = await provider.capture(options);
    expect(generation.elements.find((element) => element.tagName === 'button')?.focusVisible).toBe(
      true,
    );
    expect(validation.elements.find((element) => element.tagName === 'button')?.focusVisible).toBe(
      true,
    );
    expect(
      (await compareImages(generation.screenshot, validation.screenshot)).diffPercent,
    ).toBeGreaterThan(0);
  });
});
