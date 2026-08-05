import type { BrowserElementEvidence } from './providers.js';

export function extractElements(): BrowserElementEvidence[] {
  function getCssSelector(el: Element): string {
    if (el.id) return `#${el.id}`;
    const path: string[] = [];
    let current: Node | null = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const elCurrent = current as Element;
      const tagName = elCurrent.tagName.toLowerCase();
      let sibling: Element | null = elCurrent;
      let nth = 1;
      while (sibling = sibling.previousElementSibling) {
        if (sibling.tagName === elCurrent.tagName) nth++;
      }
      path.unshift(tagName + (nth > 1 ? `:nth-of-type(${nth})` : ''));
      current = current.parentNode;
    }
    return path.join(' > ');
  }

  function getPadding(style: CSSStyleDeclaration) {
    return {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
    };
  }

  // Helper to extract margins
  function getMargin(style: CSSStyleDeclaration) {
    return {
      top: parseFloat(style.marginTop) || 0,
      right: parseFloat(style.marginRight) || 0,
      bottom: parseFloat(style.marginBottom) || 0,
      left: parseFloat(style.marginLeft) || 0,
    };
  }

  function getRole(el: HTMLElement): string {
    if (el.getAttribute('role')) return el.getAttribute('role')!;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return el.getAttribute('href') ? 'link' : 'generic';
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return 'heading';
    if (tag === 'input') {
      const type = el.getAttribute('type') || 'text';
      if (['checkbox', 'radio', 'button'].includes(type)) return type;
      return 'textbox';
    }
    return 'generic';
  }

  function getAccessibleName(el: HTMLElement): string {
    let name = el.getAttribute('aria-label') || '';
    if (!name && el.getAttribute('aria-labelledby')) {
      const id = el.getAttribute('aria-labelledby')!;
      const target = document.getElementById(id);
      if (target) name = target.textContent || '';
    }
    if (!name && el.tagName.toLowerCase() === 'input' && el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`) || el.closest('label');
      if (label) name = label.textContent || '';
    }
    if (!name) {
      name = el.textContent || '';
    }
    return name.trim().replace(/\s+/g, ' ');
  }

  function getAccessibleState(el: HTMLElement): Record<string, string | boolean> {
    const state: Record<string, string | boolean> = {};
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      state.disabled = true;
    }
    if (el.getAttribute('aria-expanded') === 'true') {
      state.expanded = true;
    }
    if (el.getAttribute('aria-checked') === 'true') {
      state.checked = true;
    }
    return state;
  }

  function isKeyboardReachable(el: HTMLElement, style: CSSStyleDeclaration): boolean {
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    const tabIndexAttr = el.getAttribute('tabindex');
    if (tabIndexAttr !== null) {
      return parseInt(tabIndexAttr) >= 0;
    }
    const focusableTags = ['button', 'input', 'select', 'textarea', 'a', 'summary'];
    if (focusableTags.includes(el.tagName.toLowerCase())) {
      if (el.tagName.toLowerCase() === 'a' && !el.hasAttribute('href')) {
        return false;
      }
      return true;
    }
    return false;
  }

  function isFocusVisible(el: HTMLElement): boolean {
    const activeEl = document.activeElement as HTMLElement | null;
    try {
      el.focus();
      const style = window.getComputedStyle(el);
      const outlineStyle = style.outlineStyle;
      const outlineWidth = parseFloat(style.outlineWidth) || 0;
      const outlineColor = style.outlineColor;
      return outlineStyle !== 'none' && outlineWidth > 0 && outlineColor !== 'transparent';
    } catch {
      return false;
    } finally {
      if (activeEl && typeof activeEl.focus === 'function') {
        activeEl.focus();
      } else {
        el.blur();
      }
    }
  }

  const allElements = Array.from(document.querySelectorAll('*'));
  return allElements.map((el) => {
    const htmlEl = el as HTMLElement;
    const rect = htmlEl.getBoundingClientRect();
    const style = window.getComputedStyle(htmlEl);
    const validationId = htmlEl.getAttribute('data-validation-id') || undefined;

    const textWrap = style.whiteSpace !== 'nowrap' && style.textOverflow !== 'ellipsis';

    return {
      validationId,
      tagName: htmlEl.tagName.toLowerCase(),
      selector: getCssSelector(htmlEl),
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderWidth: parseFloat(style.borderWidth) || 0,
      borderRadius: parseFloat(style.borderRadius) || 0,
      opacity: parseFloat(style.opacity) || 1,
      boxShadow: style.boxShadow,
      padding: getPadding(style),
      margin: getMargin(style),
      gap: parseFloat(style.gap) || undefined,
      fontFamily: style.fontFamily,
      fontSize: parseFloat(style.fontSize) || 0,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      text: htmlEl.textContent || '',
      textWrap,
      role: getRole(htmlEl),
      accessibleName: getAccessibleName(htmlEl),
      accessibleState: getAccessibleState(htmlEl),
      keyboardReachable: isKeyboardReachable(htmlEl, style),
      focusVisible: isFocusVisible(htmlEl),
    };
  });
}
