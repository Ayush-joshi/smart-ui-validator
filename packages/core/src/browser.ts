import { chromium } from 'playwright';
import { SmartUiError } from './errors.js';
import type { BrowserCaptureOptions, BrowserProvider } from './providers.js';

export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly name = 'playwright-chromium';

  async capture(options: BrowserCaptureOptions): Promise<Uint8Array> {
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
      await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
      });
      await page.goto(options.url, { waitUntil: 'networkidle', timeout: options.timeoutMs });
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({ type: 'png', animations: 'disabled', fullPage: false });
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
