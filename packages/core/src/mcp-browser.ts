import { randomUUID } from 'node:crypto';
import { SmartUiError } from './errors.js';
import type {
  BrowserCaptureOptions,
  BrowserElementEvidence,
  BrowserEvidence,
  BrowserProvider,
} from './providers.js';
import { extractElements } from './dom-extractor.js';
import { isUrlAllowed, redactSensitiveText, sanitizeUrl } from './security.js';

export interface ChromeDevToolsMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export class ChromeDevToolsMcpBrowserProvider implements BrowserProvider {
  readonly name = 'chrome-devtools-mcp';

  constructor(private readonly mcpClient: ChromeDevToolsMcpClient) {}

  async capture(options: BrowserCaptureOptions): Promise<BrowserEvidence> {
    try {
      await this.mcpClient.callTool('new_page', {
        url: options.url,
        isolatedContext: `smart-ui-${randomUUID()}`,
        timeout: options.timeoutMs,
      });
      await this.mcpClient.callTool('resize_page', {
        width: options.viewport.width,
        height: options.viewport.height,
      });
      const elementResult = await this.mcpClient.callTool('evaluate_script', {
        function: `() => (${extractElements.toString()})(${JSON.stringify({
          maxElements: options.evidenceLimits.maxElements,
          maxTextLength: options.evidenceLimits.maxTextLength,
        })})`,
      });
      const elements = parseElements(elementResult).slice(0, options.evidenceLimits.maxElements);
      const [screenshotResult, consoleResult, networkResult] = await Promise.all([
        this.mcpClient.callTool('take_screenshot', { format: 'png', fullPage: false }),
        this.mcpClient.callTool('list_console_messages', {
          pageSize: options.evidenceLimits.maxConsoleMessages,
        }),
        this.mcpClient.callTool('list_network_requests', {
          pageSize: options.evidenceLimits.maxFailedRequests,
        }),
      ]);
      const screenshot = parseImage(screenshotResult);
      if (screenshot.byteLength > options.evidenceLimits.maxArtifactBytes) {
        throw new Error(`Screenshot exceeds ${options.evidenceLimits.maxArtifactBytes} bytes.`);
      }
      const consoleErrors = parseRecords(consoleResult)
        .filter((record) =>
          ['error', 'assert'].includes(String(record['type'] ?? record['level']).toLowerCase()),
        )
        .map((record) =>
          redactSensitiveText(String(record['text'] ?? record['message'] ?? 'Console error')),
        )
        .slice(0, options.evidenceLimits.maxConsoleMessages);
      const allowed = normalizeAllowedEndpoints(options.url, options.allowedEndpoints);
      const failedRequests = parseRecords(networkResult)
        .filter((record) => {
          const status = Number(record['status'] ?? record['statusCode'] ?? 0);
          const failed = Boolean(record['failed'] ?? record['failure']);
          const url = String(record['url'] ?? '');
          const disallowed =
            options.blockExternalNetwork && url !== '' && !isUrlAllowed(url, allowed);
          return failed || status >= 400 || disallowed;
        })
        .map(
          (record) =>
            `${sanitizeUrl(String(record['url'] ?? 'unknown'))}: ${String(record['failure'] ?? record['status'] ?? 'blocked')}`,
        )
        .slice(0, options.evidenceLimits.maxFailedRequests);
      return { screenshot, elements, consoleErrors, failedRequests };
    } catch (error) {
      throw new SmartUiError(
        'PROVIDER_FAILURE',
        `Chrome DevTools MCP capture failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
        { provider: this.name },
      );
    }
  }
}

export class MockChromeDevToolsMcpClient implements ChromeDevToolsMcpClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private readonly responses = new Map<string, unknown>();

  setResponse(tool: string, response: unknown): void {
    this.responses.set(tool, response);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (this.responses.has(name)) return this.responses.get(name);
    if (name === 'new_page' || name === 'resize_page')
      return { structuredContent: { success: true } };
    if (name === 'evaluate_script') return { structuredContent: { result: [] } };
    if (name === 'take_screenshot') {
      return {
        content: [
          {
            type: 'image',
            data: Buffer.from('mock-screenshot').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      };
    }
    if (name === 'list_console_messages' || name === 'list_network_requests') {
      return { structuredContent: { items: [] } };
    }
    throw new Error(`No mock response configured for ${name}.`);
  }
}

function parseElements(result: unknown): BrowserElementEvidence[] {
  const value = unwrap(result);
  const candidate = isRecord(value) && Array.isArray(value['result']) ? value['result'] : value;
  return Array.isArray(candidate) ? candidate.filter(isBrowserElementEvidence) : [];
}

function parseImage(result: unknown): Uint8Array {
  if (isRecord(result) && Array.isArray(result['content'])) {
    const image = result['content'].find(
      (item) => isRecord(item) && item['type'] === 'image' && typeof item['data'] === 'string',
    );
    if (isRecord(image) && typeof image['data'] === 'string') {
      return Uint8Array.from(Buffer.from(image['data'], 'base64'));
    }
  }
  const value = unwrap(result);
  if (isRecord(value)) {
    const data = value['data'] ?? value['screenshot'];
    if (typeof data === 'string') return Uint8Array.from(Buffer.from(data, 'base64'));
  }
  throw new Error('take_screenshot returned no MCP image content.');
}

function parseRecords(result: unknown): Array<Record<string, unknown>> {
  const value = unwrap(result);
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) {
    for (const key of ['items', 'messages', 'requests']) {
      if (Array.isArray(value[key])) return value[key].filter(isRecord);
    }
  }
  return [];
}

function unwrap(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result['structuredContent'] !== undefined) return result['structuredContent'];
  if (Array.isArray(result['content'])) {
    const text = result['content']
      .filter(
        (item) => isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string',
      )
      .map((item) => String(item['text']))
      .join('\n');
    if (text) {
      try {
        return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        return text;
      }
    }
  }
  return result;
}

function isBrowserElementEvidence(value: unknown): value is BrowserElementEvidence {
  return (
    isRecord(value) &&
    typeof value['selector'] === 'string' &&
    typeof value['tagName'] === 'string' &&
    typeof value['x'] === 'number' &&
    typeof value['width'] === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAllowedEndpoints(url: string, configured: readonly string[]): string[] {
  const endpoints = [...configured];
  try {
    endpoints.push(new URL(url).origin);
  } catch {
    // The provider will report malformed URLs through new_page.
  }
  return [...new Set(endpoints)];
}
