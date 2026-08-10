import { chromium, type Browser, type Page } from 'playwright';
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

  async health(): Promise<boolean> {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      return true;
    } catch {
      return false;
    } finally {
      await browser?.close();
    }
  }

  async capture(options: BrowserCaptureOptions): Promise<BrowserEvidence> {
    let browser: Browser | undefined;
    const cancel = () => void browser?.close();
    if (options.signal?.aborted) {
      throw new SmartUiError('PROVIDER_FAILURE', 'Browser capture was canceled.');
    }
    options.signal?.addEventListener('abort', cancel, { once: true });
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

      await applyInteractionState(page, options.interaction);
      const dynamicRegions = await collectDynamicRegions(
        page,
        options.dynamicRegionSelectors ?? [],
      );

      const elements = await page.evaluate(extractElements, {
        maxElements: options.evidenceLimits.maxElements,
        maxTextLength: options.evidenceLimits.maxTextLength,
      });
      const defaultScreenshot = options.screenshotBeforeFocusProbe
        ? await captureScreenshot(page, options.evidenceLimits.maxArtifactBytes)
        : undefined;
      await captureKeyboardFocus(page, elements);
      const accessibilityViolations = await collectAccessibilityViolations(page);
      const screenshot =
        defaultScreenshot ??
        (await captureScreenshot(page, options.evidenceLimits.maxArtifactBytes));

      return {
        screenshot,
        elements,
        consoleErrors: [...new Set(consoleErrors)],
        failedRequests: [...new Set(failedRequests)],
        accessibilityViolations,
        dynamicRegions,
        interactionState: options.interaction?.name ?? 'default',
      };
    } catch (error) {
      if (error instanceof SmartUiError) throw error;
      throw new SmartUiError('PROVIDER_FAILURE', `Browser capture failed: ${messageOf(error)}`, {
        provider: this.name,
      });
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      await browser?.close();
    }
  }
}

async function captureScreenshot(page: Page, maxArtifactBytes: number): Promise<Uint8Array> {
  const screenshot = await page.screenshot({
    type: 'png',
    animations: 'disabled',
    fullPage: false,
  });
  if (screenshot.byteLength > maxArtifactBytes) {
    throw new SmartUiError(
      'PROVIDER_FAILURE',
      `Screenshot exceeds evidence budget (${screenshot.byteLength} bytes).`,
    );
  }
  return screenshot;
}

async function applyInteractionState(
  page: Page,
  interaction: BrowserCaptureOptions['interaction'],
): Promise<void> {
  if (!interaction || interaction.name === 'default') return;
  await page.evaluate(
    (name) => document.documentElement.setAttribute('data-smart-ui-state', name),
    interaction.name,
  );
  if (!['hover', 'focus', 'active'].includes(interaction.name)) return;
  if (!interaction.selector) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `Interaction state '${interaction.name}' requires a selector.`,
    );
  }
  const locator = page.locator(interaction.selector).first();
  if ((await locator.count()) === 0) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `Interaction selector was not found: ${interaction.selector}`,
    );
  }
  if (interaction.name === 'hover') await locator.hover();
  if (interaction.name === 'focus') await locator.focus();
  if (interaction.name === 'active') {
    const box = await locator.boundingBox();
    if (!box)
      throw new SmartUiError(
        'INVALID_INPUT',
        `Interaction selector is not visible: ${interaction.selector}`,
      );
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
}

async function collectDynamicRegions(
  page: Page,
  selectors: readonly string[],
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  const unapproved = await page
    .locator('[data-smart-ui-dynamic]')
    .evaluateAll(
      (elements, approved) =>
        elements
          .filter(
            (element) => !(approved as string[]).some((selector) => element.matches(selector)),
          )
          .map(
            (element) =>
              element.getAttribute('data-validation-id') ||
              element.id ||
              element.tagName.toLowerCase(),
          ),
      [...selectors],
    );
  if (unapproved.length > 0) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `Dynamic regions require explicit masking policy: ${unapproved.join(', ')}`,
    );
  }
  const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const selector of selectors) {
    const locators = page.locator(selector);
    for (let index = 0; index < (await locators.count()); index++) {
      const box = await locators.nth(index).boundingBox();
      if (box) regions.push(box);
    }
  }
  return regions;
}

async function collectAccessibilityViolations(
  page: Page,
): Promise<Array<{ rule: string; selector: string; message: string }>> {
  return page.evaluate(() => {
    const violations: Array<{ rule: string; selector: string; message: string }> = [];
    const selector = (element: Element): string => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const validationId = element.getAttribute('data-validation-id');
      return validationId
        ? `[data-validation-id="${CSS.escape(validationId)}"]`
        : element.tagName.toLowerCase();
    };
    const ids = new Map<string, Element[]>();
    for (const element of document.querySelectorAll('[id]')) {
      const id = element.id;
      ids.set(id, [...(ids.get(id) ?? []), element]);
    }
    for (const [id, elements] of ids) {
      if (elements.length > 1)
        violations.push({
          rule: 'duplicate-id',
          selector: `#${CSS.escape(id)}`,
          message: `The id '${id}' is used ${elements.length} times.`,
        });
    }
    for (const image of document.querySelectorAll('img:not([alt])')) {
      violations.push({
        rule: 'image-alt',
        selector: selector(image),
        message: 'Image is missing an alt attribute.',
      });
    }
    for (const control of document.querySelectorAll('button, input, select, textarea, a[href]')) {
      const labelled =
        control.getAttribute('aria-label') ||
        control.getAttribute('aria-labelledby') ||
        control.getAttribute('title') ||
        control.textContent?.trim() ||
        (control.id
          ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent?.trim()
          : '');
      if (!labelled)
        violations.push({
          rule: 'accessible-name',
          selector: selector(control),
          message: 'Interactive control has no accessible name.',
        });
    }
    if (!document.documentElement.lang)
      violations.push({
        rule: 'document-language',
        selector: 'html',
        message: 'Document language is not declared.',
      });
    return violations;
  });
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
