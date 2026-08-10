import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserElementEvidence,
  BrowserEvidence,
  DesignContract,
  DesignElement,
} from '../packages/core/src/index.js';

/** Unprivileged Windows sessions cannot create symbolic links, so link containment is unprovable there. */
export const symlinksSupported = await detectSymlinkSupport();

async function detectSymlinkSupport(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), 'smart-ui-symlink-probe-'));
  try {
    await symlink(root, join(root, 'probe'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

export const EMPTY_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function designElement(overrides: Partial<DesignElement> = {}): DesignElement {
  return {
    validationId: 'element',
    type: 'div',
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    ...overrides,
  };
}

export function contract(
  reference: DesignContract['reference'],
  elements: DesignElement[] = [designElement()],
): DesignContract {
  return {
    schemaVersion: '1.0',
    id: 'test-contract',
    name: 'Test component',
    viewport: { width: 320, height: 240, deviceScaleFactor: 1 },
    theme: 'light',
    locale: 'en-US',
    component: { name: 'TestComponent', route: '/' },
    reference,
    provenance: {
      provider: 'test',
      source: 'test',
      capturedAt: '2026-08-06T00:00:00.000Z',
      sourceHash: reference.hash,
    },
    ambiguities: [],
    elements,
    sourceEvidence: { assets: [], uncertainties: [] },
  };
}

export function browserElement(
  overrides: Partial<BrowserElementEvidence> = {},
): BrowserElementEvidence {
  return {
    validationId: 'element',
    tagName: 'div',
    selector: '[data-validation-id="element"]',
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderColor: 'rgb(0, 0, 0)',
    borderWidth: 0,
    borderRadius: 0,
    opacity: 1,
    boxShadow: 'none',
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    gap: 0,
    alignItems: 'normal',
    justifyContent: 'normal',
    overflowX: 'visible',
    overflowY: 'visible',
    fontFamily: 'Arial',
    fontSize: 16,
    fontWeight: '400',
    lineHeight: '24px',
    letterSpacing: '0px',
    text: 'Hello',
    textWrap: false,
    lineCount: 1,
    assetSource: undefined,
    intrinsicWidth: undefined,
    intrinsicHeight: undefined,
    objectFit: 'fill',
    objectPosition: '50% 50%',
    role: 'generic',
    accessibleName: 'Hello',
    accessibleState: {},
    keyboardReachable: false,
    focusVisible: false,
    ...overrides,
  };
}

export function evidence(
  elements: BrowserElementEvidence[] = [browserElement()],
  overrides: Partial<BrowserEvidence> = {},
): BrowserEvidence {
  return {
    screenshot: PNG_BYTES,
    elements,
    consoleErrors: [],
    failedRequests: [],
    ...overrides,
  };
}
