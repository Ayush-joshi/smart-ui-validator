import type { BrowserElementEvidence } from './providers.js';

export interface DomExtractionOptions {
  maxElements: number;
  maxTextLength: number;
}

/** Runs in the page. Keep this function self-contained and serializable. */
export function extractElements(options: DomExtractionOptions): BrowserElementEvidence[] {
  function getCssSelector(element: Element): string {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const validationId = element.getAttribute('data-validation-id');
    if (validationId) return `[data-validation-id="${CSS.escape(validationId)}"]`;
    const path: string[] = [];
    let current: Element | null = element;
    while (current) {
      const tagName = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (sibling) => sibling.tagName === current?.tagName,
          )
        : [];
      const index = siblings.indexOf(current);
      path.unshift(`${tagName}${siblings.length > 1 ? `:nth-of-type(${index + 1})` : ''}`);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  function parsePixels(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getEdges(style: CSSStyleDeclaration, prefix: 'padding' | 'margin') {
    return {
      top: parsePixels(style[`${prefix}Top`]),
      right: parsePixels(style[`${prefix}Right`]),
      bottom: parsePixels(style[`${prefix}Bottom`]),
      left: parsePixels(style[`${prefix}Left`]),
    };
  }

  function getRole(element: HTMLElement): string {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = element.getAttribute('type') ?? 'text';
      if (type === 'checkbox' || type === 'radio' || type === 'button') return type;
      return 'textbox';
    }
    return 'generic';
  }

  function getAccessibleName(element: HTMLElement): string {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return text.replace(/\s+/g, ' ');
    }
    if (element instanceof HTMLImageElement && element.alt) return element.alt.trim();
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label?.textContent) return label.textContent.trim().replace(/\s+/g, ' ');
    }
    const wrappingLabel = element.closest('label');
    if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim().replace(/\s+/g, ' ');
    const title = element.getAttribute('title');
    if (title) return title.trim();
    return (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, options.maxTextLength);
  }

  function getAccessibleState(element: HTMLElement): Record<string, string | boolean | number> {
    const state: Record<string, string | boolean | number> = {};
    for (const name of [
      'disabled',
      'expanded',
      'checked',
      'selected',
      'pressed',
      'busy',
      'invalid',
    ]) {
      const value = element.getAttribute(`aria-${name}`);
      if (value !== null) state[name] = value === 'true' ? true : value === 'false' ? false : value;
    }
    if ('disabled' in element && (element as HTMLButtonElement).disabled) state.disabled = true;
    if ('checked' in element && typeof (element as HTMLInputElement).checked === 'boolean') {
      state.checked = (element as HTMLInputElement).checked;
    }
    return state;
  }

  function isKeyboardReachable(element: HTMLElement, style: CSSStyleDeclaration): boolean {
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity) === 0 ||
      element.hasAttribute('disabled') ||
      element.getAttribute('aria-disabled') === 'true'
    ) {
      return false;
    }
    if (element.tabIndex >= 0) return true;
    return element.isContentEditable;
  }

  function getLineCount(element: HTMLElement): number {
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops = new Set(
      [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => Math.round(rect.top * 10) / 10),
    );
    return Math.max(1, tops.size);
  }

  function getContrastRatio(element: HTMLElement, style: CSSStyleDeclaration): number | undefined {
    function color(value: string): [number, number, number, number] | undefined {
      const match = value.match(
        /rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i,
      );
      if (!match) return undefined;
      return [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === undefined ? 1 : Number(match[4]),
      ];
    }
    function luminance(rgb: [number, number, number]): number {
      const values = rgb.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
    }
    const foreground = color(style.color);
    let current: Element | null = element;
    let background: [number, number, number, number] | undefined;
    while (current) {
      const candidate = color(window.getComputedStyle(current).backgroundColor);
      if (candidate && candidate[3] > 0) {
        background = candidate;
        break;
      }
      current = current.parentElement;
    }
    if (!foreground || !background || foreground[3] < 1 || background[3] < 1) return undefined;
    const left = luminance([foreground[0], foreground[1], foreground[2]]);
    const right = luminance([background[0], background[1], background[2]]);
    return (
      Math.round(((Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)) * 100) / 100
    );
  }

  const candidates = [...document.querySelectorAll<HTMLElement>('body, body *')].filter(
    (element) => {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        element.hasAttribute('data-validation-id') ||
        (rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden')
      );
    },
  );

  return candidates.slice(0, options.maxElements).map((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const lineCount = getLineCount(element);
    const image = element instanceof HTMLImageElement ? element : undefined;
    const backgroundMatch = style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
    const gapValue = Number.parseFloat(style.gap);
    const opacityValue = Number.parseFloat(style.opacity);
    return {
      validationId: element.getAttribute('data-validation-id') ?? undefined,
      tagName: element.tagName.toLowerCase(),
      selector: getCssSelector(element),
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderWidth: parsePixels(style.borderWidth),
      borderRadius: parsePixels(style.borderRadius),
      opacity: Number.isFinite(opacityValue) ? opacityValue : 1,
      boxShadow: style.boxShadow,
      padding: getEdges(style, 'padding'),
      margin: getEdges(style, 'margin'),
      gap: Number.isFinite(gapValue) ? gapValue : undefined,
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      fontFamily: style.fontFamily,
      fontSize: parsePixels(style.fontSize),
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      text: (element.textContent ?? '').slice(0, options.maxTextLength),
      textWrap: lineCount > 1,
      lineCount,
      assetSource: image?.currentSrc || image?.src || backgroundMatch?.[1] || undefined,
      intrinsicWidth: image?.naturalWidth,
      intrinsicHeight: image?.naturalHeight,
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      role: getRole(element),
      accessibleName: getAccessibleName(element),
      accessibleState: getAccessibleState(element),
      keyboardReachable: isKeyboardReachable(element, style),
      focusVisible: false,
      ...(() => {
        const contrastRatio = getContrastRatio(element, style);
        return contrastRatio === undefined ? {} : { contrastRatio };
      })(),
    };
  });
}
