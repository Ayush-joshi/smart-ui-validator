import { describe, expect, it } from 'vitest';
import { PlaywrightBrowserProvider } from '../packages/core/src/index.js';
import type { SmartUiError } from '../packages/core/src/index.js';

describe('PlaywrightBrowserProvider failures', () => {
  it('returns a typed provider failure and closes resources', async () => {
    const capture = new PlaywrightBrowserProvider().capture({
      url: 'http://127.0.0.1:1',
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      timeoutMs: 1_000,
      locale: 'en-US',
      theme: 'light',
      allowedEndpoints: ['http://127.0.0.1:1'],
      blockExternalNetwork: true,
      evidenceLimits: {
        maxElements: 100,
        maxTextLength: 1_000,
        maxConsoleMessages: 20,
        maxFailedRequests: 20,
        maxArtifactBytes: 1_000_000,
      },
    });
    await expect(capture).rejects.toMatchObject<Partial<SmartUiError>>({
      code: 'PROVIDER_FAILURE',
    });
  });
});
