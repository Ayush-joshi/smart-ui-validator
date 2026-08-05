import { describe, expect, it } from 'vitest';
import {
  ChromeDevToolsMcpBrowserProvider,
  MockChromeDevToolsMcpClient,
} from '../packages/core/src/index.js';
import { browserElement, PNG_BYTES } from './helpers.js';

describe('Chrome DevTools MCP adapter contract', () => {
  it('uses official tool names/arguments and collects console/network evidence', async () => {
    const client = new MockChromeDevToolsMcpClient();
    client.setResponse('evaluate_script', { structuredContent: { result: [browserElement()] } });
    client.setResponse('take_screenshot', {
      content: [
        { type: 'image', data: Buffer.from(PNG_BYTES).toString('base64'), mimeType: 'image/png' },
      ],
    });
    client.setResponse('list_console_messages', {
      structuredContent: { messages: [{ type: 'error', text: 'Authorization: Bearer abc' }] },
    });
    client.setResponse('list_network_requests', {
      structuredContent: {
        requests: [{ url: 'https://blocked.test/a?token=secret', status: 500 }],
      },
    });
    const evidence = await new ChromeDevToolsMcpBrowserProvider(client).capture({
      url: 'http://127.0.0.1:4173',
      viewport: { width: 320, height: 240, deviceScaleFactor: 1 },
      timeoutMs: 5_000,
      locale: 'en-US',
      theme: 'light',
      allowedEndpoints: ['http://127.0.0.1:4173'],
      blockExternalNetwork: true,
      evidenceLimits: {
        maxElements: 100,
        maxTextLength: 1_000,
        maxConsoleMessages: 10,
        maxFailedRequests: 10,
        maxArtifactBytes: 1_000_000,
      },
    });
    expect(client.calls.map((call) => call.name)).toEqual([
      'new_page',
      'resize_page',
      'evaluate_script',
      'take_screenshot',
      'list_console_messages',
      'list_network_requests',
    ]);
    expect(client.calls.find((call) => call.name === 'evaluate_script')?.args).toHaveProperty(
      'function',
    );
    expect(client.calls.some((call) => 'expression' in call.args || 'script' in call.args)).toBe(
      false,
    );
    expect(evidence.elements).toHaveLength(1);
    expect(evidence.consoleErrors[0]).not.toContain('abc');
    expect(evidence.failedRequests[0]).not.toContain('secret');
  });
});
