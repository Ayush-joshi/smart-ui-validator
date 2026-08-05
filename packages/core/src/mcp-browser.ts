import { SmartUiError } from './errors.js';
import type { BrowserCaptureOptions, BrowserEvidence, BrowserProvider } from './providers.js';
import { extractElements } from './dom-extractor.js';

export interface ChromeDevToolsMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export class ChromeDevToolsMcpBrowserProvider implements BrowserProvider {
  readonly name = 'chrome-devtools-mcp';

  constructor(private readonly mcpClient: ChromeDevToolsMcpClient) {}

  async capture(options: BrowserCaptureOptions): Promise<BrowserEvidence> {
    try {
      await this.mcpClient.callTool('navigate_page', { url: options.url });

      const scriptStr = `(${extractElements.toString()})()`;
      const elements = await this.mcpClient.callTool('evaluate_script', {
        expression: scriptStr,
        script: scriptStr,
      });

      const snapshotResult = (await this.mcpClient.callTool('take_snapshot', {})) as {
        data?: string;
        screenshot?: string;
      };
      const base64Data = snapshotResult.data || snapshotResult.screenshot || '';
      const screenshot = Uint8Array.from(Buffer.from(base64Data, 'base64'));

      return {
        screenshot,
        elements: Array.isArray(elements) ? elements : [],
        consoleErrors: [],
        failedRequests: [],
      };
    } catch (error: any) {
      throw new SmartUiError('PROVIDER_FAILURE', `Chrome DevTools MCP capture failed: ${error.message || error}`, {
        provider: this.name,
      });
    }
  }
}

export class MockChromeDevToolsMcpClient implements ChromeDevToolsMcpClient {
  private readonly responses = new Map<string, unknown>();

  setResponse(tool: string, args: Record<string, unknown>, response: unknown) {
    const key = `${tool}:${JSON.stringify(args)}`;
    this.responses.set(key, response);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const key = `${name}:${JSON.stringify(args)}`;
    if (this.responses.has(key)) {
      return this.responses.get(key);
    }
    if (name === 'navigate_page') {
      return { success: true };
    }
    if (name === 'evaluate_script') {
      return [];
    }
    if (name === 'take_snapshot') {
      return { data: Buffer.from('mock-screenshot').toString('base64') };
    }
    throw new Error(`No mock response configured for tool ${name} with args ${JSON.stringify(args)}`);
  }
}
