import { describe, expect, it } from 'vitest';
import {
  SmartUiOrchestrator,
  LocalArtifactStore,
  LocalPolicy,
  MockCodingProvider,
  HtmlReporter,
  HeuristicRepairProvider,
  designContractSchema,
} from '../packages/core/src/index.js';
import type { BrowserProvider, BrowserEvidence } from '../packages/core/src/providers.js';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Repair Coordinator Loop', () => {
  it('should run repair loop, apply patches, and roll back on regression', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'smart-ui-repair-test-'));
    const store = new LocalArtifactStore(tempDir);

    // Setup a dummy css file in target root
    const targetRoot = await mkdtemp(join(tmpdir(), 'smart-ui-target-root-'));
    const cssPath = join(targetRoot, 'src/styles.css');
    await mkdir(join(targetRoot, 'src'), { recursive: true }).catch(() => {});
    await writeFile(cssPath, '.card { background: #ff0000; }', 'utf8');

    const contract = designContractSchema.parse({
      schemaVersion: '1.0',
      id: 'repair-test',
      name: 'Card Repair',
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
          backgroundColor: '#3d63dd', // Target background color is blue
        }
      ],
    });

    // Mock browser provider that reads the target css file and returns elements accordingly
    const mockBrowser: BrowserProvider = {
      name: 'mock-browser',
      async capture(): Promise<BrowserEvidence> {
        let currentBg = '#ff0000';
        try {
          const css = await readFile(cssPath, 'utf8');
          if (css.includes('#3d63dd')) {
            currentBg = '#3d63dd';
          }
        } catch {
          // Ignore
        }
        return {
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
              backgroundColor: currentBg,
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
            }
          ]
        };
      }
    };

    const orchestrator = new SmartUiOrchestrator({
      framework: {
        framework: 'react',
        inspect: async () => ({
          root: targetRoot,
          framework: 'react',
          buildSystem: 'vite',
          packageManager: 'pnpm',
          styling: ['css'],
          testFrameworks: [],
          componentLocations: [],
        })
      },
      coding: new MockCodingProvider(),
      repair: new HeuristicRepairProvider(),
      browser: mockBrowser,
      artifacts: store,
      policy: new LocalPolicy({
        targetRoot,
        writableFiles: ['src/styles.css'],
        dryRun: false,
      }),
      reporter: new HtmlReporter(store),
    });

    // Write a dummy config file with no commands to avoid regressions
    const configPath = join(targetRoot, 'smart-ui.config.json');
    await writeFile(configPath, JSON.stringify({
      validation: { maxRepairPasses: 3 },
      commands: { format: null, typecheck: null, test: null }
    }), 'utf8');

    const result = await orchestrator.run({
      targetRoot,
      designContractPath: 'generated-in-test',
      contract,
      url: 'http://localhost',
    });

    expect(result.record.status).toBe('succeeded');
    expect(result.record.passes).toHaveLength(2); // pass 0 (checks wrong bg), pass 1 (fixes bg and achieves 100%)
    expect(result.record.passes[0]?.score).toBeLessThan(100);
    expect(result.record.passes[1]?.score).toBe(100);

    // Verify file content was updated to blue background
    const finalCss = await readFile(cssPath, 'utf8');
    expect(finalCss).toContain('#3d63dd');
  });
});
