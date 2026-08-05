import { chromium } from 'playwright';
import { SmartUiError } from './errors.js';
import type { BrowserCaptureOptions, BrowserEvidence, BrowserProvider } from './providers.js';
import { extractElements } from './dom-extractor.js';

export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly name = 'playwright-chromium';

  async capture(options: BrowserCaptureOptions): Promise<BrowserEvidence> {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: options.viewport.width, height: options.viewport.height },
        deviceScaleFactor: options.viewport.deviceScaleFactor,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();

      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });
      page.on('pageerror', (err) => {
        consoleErrors.push(err.stack || err.message);
      });

      const failedRequests: string[] = [];
      page.on('requestfailed', (request) => {
        const failure = request.failure();
        failedRequests.push(`${request.url()}: ${failure ? failure.errorText : 'Failed'}`);
      });

      await page.goto(options.url, { waitUntil: 'networkidle', timeout: options.timeoutMs });
      await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
      });
      await page.evaluate(() => document.fonts.ready);

      const elements = await page.evaluate(extractElements);
      const screenshot = await page.screenshot({ type: 'png', animations: 'disabled', fullPage: false });

      return {
        screenshot,
        elements,
        consoleErrors,
        failedRequests,
      };
    } catch (error) {
      throw new SmartUiError('PROVIDER_FAILURE', `Browser capture failed: ${messageOf(error)}`, {
        provider: this.name,
      });
    } finally {
      await browser?.close();
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
