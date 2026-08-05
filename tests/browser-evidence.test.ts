import { describe, expect, it } from 'vitest';
import { PlaywrightBrowserProvider } from '../packages/core/src/index.js';

describe('deterministic browser evidence', () => {
  it('preserves zero values, measures wrapping/focus, and blocks external requests', async () => {
    const html = `<style>button:focus-visible{outline:3px solid blue}.wrap{width:30px}</style>
      <div id="zero" style="opacity:0;display:flex;gap:0">hidden</div>
      <div id="wrap" class="wrap">one two three</div>
      <button data-validation-id="action">Go</button>
      <img src="https://blocked.test/private.png?token=secret">`;
    const result = await new PlaywrightBrowserProvider().capture({
      url: `data:text/html,${encodeURIComponent(html)}`,
      viewport: { width: 320, height: 240, deviceScaleFactor: 1 },
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
  });
});
