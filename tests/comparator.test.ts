import { describe, expect, it } from 'vitest';
import { SmartUiComparator, configSchema } from '../packages/core/src/index.js';
import type { DesignContract } from '../packages/core/src/schemas.js';
import type { BrowserEvidence } from '../packages/core/src/providers.js';

describe('Validation Comparator', () => {
  const defaultConfig = configSchema.parse({});
  const comparator = new SmartUiComparator(defaultConfig);

  const mockContract: DesignContract = {
    schemaVersion: '1.0',
    id: 'test-contract',
    name: 'Test Component',
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    theme: 'light',
    locale: 'en-US',
    component: { name: 'Card', route: '/' },
    reference: { hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', mediaType: 'image/png', relativePath: 'ref.png', byteLength: 0 },
    provenance: { provider: 'test', source: 'test', capturedAt: new Date().toISOString(), sourceHash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    ambiguities: [],
    elements: [
      {
        validationId: 'card-root',
        type: 'frame',
        x: 100,
        y: 100,
        width: 300,
        height: 200,
        backgroundColor: '#ffffff',
      },
      {
        validationId: 'card-title',
        type: 'text',
        x: 120,
        y: 120,
        width: 200,
        height: 30,
        color: '#333333',
        fontSize: 16,
      }
    ],
  };

  it('should return 100 score and no findings when elements match perfectly', async () => {
    const mockEvidence: BrowserEvidence = {
      screenshot: new Uint8Array(0),
      consoleErrors: [],
      failedRequests: [],
      elements: [
        {
          validationId: 'card-root',
          tagName: 'div',
          selector: 'div',
          x: 100,
          y: 100,
          width: 300,
          height: 200,
          color: '#000000',
          backgroundColor: '#ffffff',
          borderColor: 'transparent',
          borderWidth: 0,
          borderRadius: 0,
          opacity: 1,
          boxShadow: 'none',
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          gap: undefined,
          fontFamily: 'Arial',
          fontSize: 14,
          fontWeight: 'normal',
          lineHeight: 'normal',
          letterSpacing: 'normal',
          text: '',
          textWrap: true,
          role: 'generic',
          accessibleName: '',
          accessibleState: {},
          keyboardReachable: false,
          focusVisible: false,
        },
        {
          validationId: 'card-title',
          tagName: 'h1',
          selector: 'h1',
          x: 120,
          y: 120,
          width: 200,
          height: 30,
          color: '#333333',
          backgroundColor: 'transparent',
          borderColor: 'transparent',
          borderWidth: 0,
          borderRadius: 0,
          opacity: 1,
          boxShadow: 'none',
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          gap: undefined,
          fontFamily: 'Arial',
          fontSize: 16,
          fontWeight: 'bold',
          lineHeight: 'normal',
          letterSpacing: 'normal',
          text: 'Hello World',
          textWrap: true,
          role: 'heading',
          accessibleName: 'Hello World',
          accessibleState: {},
          keyboardReachable: false,
          focusVisible: false,
        }
      ],
    };

    const result = await comparator.compare(mockContract, mockEvidence, null);
    expect(result.score).toBe(100);
    expect(result.findings).toHaveLength(0);
  });

  it('should detect position/size, appearance, and accessibility mismatches', async () => {
    const mockEvidence: BrowserEvidence = {
      screenshot: new Uint8Array(0),
      consoleErrors: ['Uncaught Error: Test'],
      failedRequests: [],
      elements: [
        {
          validationId: 'card-root',
          tagName: 'div',
          selector: 'div',
          x: 150, // Mismatch (expected 100)
          y: 100,
          width: 300,
          height: 250, // Mismatch (expected 200)
          color: '#000000',
          backgroundColor: '#ff0000', // Mismatch (expected #ffffff)
          borderColor: 'transparent',
          borderWidth: 0,
          borderRadius: 0,
          opacity: 1,
          boxShadow: 'none',
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          gap: undefined,
          fontFamily: 'Arial',
          fontSize: 14,
          fontWeight: 'normal',
          lineHeight: 'normal',
          letterSpacing: 'normal',
          text: '',
          textWrap: true,
          role: 'generic',
          accessibleName: '',
          accessibleState: {},
          keyboardReachable: false,
          focusVisible: false,
        },
        {
          validationId: 'card-title',
          tagName: 'button',
          selector: 'button',
          x: 120,
          y: 120,
          width: 200,
          height: 30,
          color: '#333333',
          backgroundColor: 'transparent',
          borderColor: 'transparent',
          borderWidth: 0,
          borderRadius: 0,
          opacity: 1,
          boxShadow: 'none',
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          gap: undefined,
          fontFamily: 'Arial',
          fontSize: 16,
          fontWeight: 'bold',
          lineHeight: 'normal',
          letterSpacing: 'normal',
          text: 'Hello World',
          textWrap: true,
          role: 'button', // accessibility role button should be keyboard reachable
          accessibleName: 'Hello World',
          accessibleState: {},
          keyboardReachable: false, // Mismatch (accessibility error)
          focusVisible: false,
        }
      ],
    };

    const result = await comparator.compare(mockContract, mockEvidence, null);
    expect(result.score).toBeLessThan(100);
    expect(result.findings).toHaveLength(5); // 1 position, 1 size, 1 bg-color, 1 console error, 1 accessibility keyboard reachability

    const geomFinding = result.findings.find(f => f.category === 'geometry' && f.suggestedRepairCategory === 'position');
    expect(geomFinding).toBeDefined();
    expect(geomFinding?.expected).toEqual({ x: 100, y: 100 });

    const colorFinding = result.findings.find(f => f.category === 'appearance' && f.suggestedRepairCategory === 'background_color');
    expect(colorFinding).toBeDefined();

    const consoleFinding = result.findings.find(f => f.category === 'runtime');
    expect(consoleFinding?.message).toContain('Uncaught Error: Test');
  });
});
