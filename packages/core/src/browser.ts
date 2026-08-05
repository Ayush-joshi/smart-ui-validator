import { chromium, type Page } from 'playwright';
import { extractElements } from './dom-extractor.js';
import { SmartUiError } from './errors.js';
import type {
  BrowserCaptureOptions,
  BrowserElementEvidence,
  BrowserEvidence,
  BrowserProvider,
} from './providers.js';
import { isUrlAllowed, redactSensitiveText, sanitizeUrl } from './security.js';

const FIXED_TIME = Date.UTC(2020, 0, 1, 12, 0, 0);

export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly name = 'playwright-chromium';

  async capture(options: BrowserCaptureOptions): Promise<BrowserEvidence> {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: options.viewport.width, height: options.viewport.height },
        deviceScaleFactor: options.viewport.deviceScaleFactor,
        locale: options.locale,
        timezoneId: 'UTC',
        colorScheme: options.theme,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      await context.addInitScript((fixedTime) => {
        Date.now = () => fixedTime;
      }, FIXED_TIME);

      const allowedEndpoints = normalizeAllowedEndpoints(options.url, options.allowedEndpoints);
      if (options.blockExternalNetwork) {
        await context.route('**/*', async (route) => {
          if (isUrlAllowed(route.request().url(), allowedEndpoints)) await route.continue();
          else await route.abort('blockedbyclient');
        });
      }

      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          consoleErrors.length < options.evidenceLimits.maxConsoleMessages
        ) {
          consoleErrors.push(redactSensitiveText(message.text()));
        }
      });
      page.on('pageerror', (error) => {
        if (consoleErrors.length < options.evidenceLimits.maxConsoleMessages) {
          consoleErrors.push(redactSensitiveText(error.stack || error.message));
        }
      });
      page.on('requestfailed', (request) => {
        if (failedRequests.length < options.evidenceLimits.maxFailedRequests) {
          failedRequests.push(
            `${sanitizeUrl(request.url())}: ${request.failure()?.errorText ?? 'Failed'}`,
          );
        }
      });
      page.on('response', (response) => {
        if (
          response.status() >= 400 &&
          failedRequests.length < options.evidenceLimits.maxFailedRequests
        ) {
          failedRequests.push(`${sanitizeUrl(response.url())}: HTTP ${response.status()}`);
        }
      });

      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await page.addStyleTag({
        content:
          '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}',
      });
      await page.evaluate(async () => document.fonts.ready);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );

      const elements = await page.evaluate(extractElements, {
        maxElements: options.evidenceLimits.maxElements,
        maxTextLength: options.evidenceLimits.maxTextLength,
      });
      await captureKeyboardFocus(page, elements);
      const screenshot = await page.screenshot({
        type: 'png',
        animations: 'disabled',
        fullPage: false,
      });
      if (screenshot.byteLength > options.evidenceLimits.maxArtifactBytes) {
        throw new SmartUiError(
          'PROVIDER_FAILURE',
          `Screenshot exceeds evidence budget (${screenshot.byteLength} bytes).`,
        );
      }

      return {
        screenshot,
        elements,
        consoleErrors: [...new Set(consoleErrors)],
        failedRequests: [...new Set(failedRequests)],
      };
    } catch (error) {
      if (error instanceof SmartUiError) throw error;
      throw new SmartUiError('PROVIDER_FAILURE', `Browser capture failed: ${messageOf(error)}`, {
        provider: this.name,
      });
    } finally {
      await browser?.close();
    }
  }
}

async function captureKeyboardFocus(page: Page, elements: BrowserElementEvidence[]): Promise<void> {
  const focusableCount = elements.filter((element) => element.keyboardReachable).length;
  for (let index = 0; index < focusableCount + 1; index++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = window.getComputedStyle(element);
      const outlineVisible =
        style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      const shadowVisible = style.boxShadow !== 'none';
      return {
        validationId: element.getAttribute('data-validation-id') ?? undefined,
        id: element.id || undefined,
        tagName: element.tagName.toLowerCase(),
        accessibleName:
          element.getAttribute('aria-label') ||
          element.textContent?.trim().replace(/\s+/g, ' ') ||
          '',
        focusVisible: element.matches(':focus-visible') && (outlineVisible || shadowVisible),
      };
    });
    if (!focused) continue;
    const matching = elements.find(
      (element) =>
        (focused.validationId && element.validationId === focused.validationId) ||
        (focused.id && element.selector === `#${focused.id}`) ||
        (element.tagName === focused.tagName && element.accessibleName === focused.accessibleName),
    );
    if (matching) matching.focusVisible = focused.focusVisible;
  }
}

function normalizeAllowedEndpoints(url: string, configured: readonly string[]): string[] {
  const endpoints = [...configured];
  try {
    endpoints.push(new URL(url).origin);
  } catch {
    if (url.startsWith('data:')) endpoints.push('data:');
  }
  return [...new Set(endpoints)];
}

function messageOf(error: unknown): string {
  return error instanceof Error
    ? redactSensitiveText(error.message)
    : redactSensitiveText(String(error));
}
