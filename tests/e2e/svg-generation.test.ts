import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  DeterministicHtmlGenerationProvider,
  GenerationOrchestrator,
  HtmlGenerationReporter,
  LocalArtifactStore,
  LocalSvgStructureProvider,
  LoopbackGeneratedPreviewProvider,
  PlaywrightBrowserProvider,
  ReproducibleGenerationExporter,
  configSchema,
} from '../../packages/core/src/index.js';

const executeFile = promisify(execFile);

describe('SVG generation real-browser vertical slice', () => {
  it('generates, renders, compares, reports, archives, and exports without network access', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generation-e2e-'));
    const svgPath = join(workspace, 'screen.svg');
    await writeFile(svgPath, await readFile(resolve('fixtures/svg-generation/basic.svg')));
    const artifactRoot = join(workspace, '.smart-ui', 'generations', 'run-1');
    const exportRoot = join(workspace, 'exported-ui');
    const config = configSchema.parse({});
    const store = new LocalArtifactStore(artifactRoot);
    const result = await new GenerationOrchestrator({
      structure: new LocalSvgStructureProvider(store, config.generation.limits),
      generator: new DeterministicHtmlGenerationProvider(),
      preview: new LoopbackGeneratedPreviewProvider(),
      browser: new PlaywrightBrowserProvider(),
      artifacts: store,
      reporter: new HtmlGenerationReporter(store),
      exporter: new ReproducibleGenerationExporter(workspace),
      config,
    }).run({
      workspaceRoot: workspace,
      svgPath,
      artifactRoot,
      exportRoot,
      mode: 'exact',
      layout: 'responsive',
      rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
      dryRun: false,
    });

    expect(result.record.failures).toEqual([]);
    expect(result.record.status).toBe('succeeded');
    expect(result.record.originalInputHash).toMatch(/^sha256:/);
    expect(result.record.sanitizedHash).toMatch(/^sha256:/);
    expect(result.record.passes[0]).toMatchObject({
      diffPercent: 0,
      screenshot: { mediaType: 'image/png' },
      diff: { mediaType: 'image/png' },
      overlay: { mediaType: 'image/png' },
    });
    expect(result.record.archive).toMatchObject({ mediaType: 'application/zip' });
    expect(result.record.report).toMatchObject({ mediaType: 'text/html' });
    expect(result.record.viewports[0]).toMatchObject({ classification: 'source-fidelity' });
    expect(result.record.viewports[1]).toMatchObject({
      classification: 'responsive-robustness',
    });
    expect(result.record.viewports[1]).not.toHaveProperty('similarity');
    expect(result.exportedFiles.map((path) => path.slice(exportRoot.length + 1))).toEqual([
      'index.html',
      'styles.css',
    ]);
    const html = await readFile(join(exportRoot, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(?:href|src)=["']https?:\/\//);
    const zip = await store.read(result.record.archive!.relativePath);
    expect(new TextDecoder().decode(zip.slice(0, 2))).toBe('PK');
  }, 30_000);

  it('exposes the same successful vertical slice through smart-ui generate', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generation-cli-e2e-'));
    const svgPath = join(workspace, 'screen.svg');
    const exportRoot = join(workspace, 'generated');
    await writeFile(svgPath, await readFile(resolve('fixtures/svg-generation/basic.svg')));
    const { stdout } = await executeFile(
      process.execPath,
      [
        resolve('apps/cli/dist/index.js'),
        'generate',
        '--workspace',
        workspace,
        '--design',
        svgPath,
        '--output',
        exportRoot,
        '--mode',
        'exact',
        '--json',
      ],
      { cwd: resolve('.') },
    );
    const result = JSON.parse(stdout) as {
      status: string;
      files: Array<{ relativePath: string }>;
      viewports: Array<{ classification: string; similarity?: number }>;
      record: string;
      report: string;
      archive: string;
    };
    expect(result.status).toBe('succeeded');
    expect(result.files.map((file) => file.relativePath)).toEqual(['index.html', 'styles.css']);
    expect(result.viewports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification: 'source-fidelity' }),
        expect.objectContaining({ classification: 'responsive-robustness' }),
      ]),
    );
    expect(
      result.viewports.find((item) => item.classification === 'responsive-robustness'),
    ).not.toHaveProperty('similarity');
    await expect(readFile(result.record)).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(result.report)).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(result.archive)).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(join(exportRoot, 'index.html'), 'utf8')).resolves.toContain(
      '<!doctype html>',
    );
  }, 30_000);

  it('compares a small intrinsic component on a larger explicit canvas without scale drift', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generation-canvas-e2e-'));
    const svgPath = join(workspace, 'component.svg');
    await writeFile(
      svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" rx="8" fill="#2457ff"/></svg>',
    );
    const artifactRoot = join(workspace, '.smart-ui', 'generations', 'custom-canvas');
    const config = configSchema.parse({});
    const store = new LocalArtifactStore(artifactRoot);
    const result = await new GenerationOrchestrator({
      structure: new LocalSvgStructureProvider(store, config.generation.limits),
      generator: new DeterministicHtmlGenerationProvider(),
      preview: new LoopbackGeneratedPreviewProvider(),
      browser: new PlaywrightBrowserProvider(),
      artifacts: store,
      reporter: new HtmlGenerationReporter(store),
      exporter: new ReproducibleGenerationExporter(workspace),
      config,
    }).run({
      workspaceRoot: workspace,
      svgPath,
      artifactRoot,
      mode: 'exact',
      layout: 'component',
      presentationSpec: {
        schemaVersion: '1.0',
        primaryCanvas: { id: 'component-demo', width: 400, height: 300, deviceScaleFactor: 2 },
        fit: 'contain',
        horizontalAlignment: 'center',
        verticalAlignment: 'center',
        viewports: [],
      },
      structuredDesignContext: {
        schemaVersion: '1.0',
        exactCopy: [
          {
            id: 'component-name',
            label: 'Component name',
            text: 'Blue component',
            sourceNodeIds: [],
            provenance: 'owned e2e fixture',
          },
        ],
        designTokens: [],
        componentSemantics: [],
        interactions: [],
      },
      rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
      dryRun: false,
    });
    expect(result.record.schemaVersion).toBe('2.0');
    expect(result.record.passes[0]?.diffPercent).toBe(0);
    expect(result.record.viewports[0]).toMatchObject({
      name: 'component-demo',
      viewport: { width: 400, height: 300, deviceScaleFactor: 2 },
      similarity: 100,
    });
    if (result.record.schemaVersion === '2.0') {
      expect(result.record.input.presentationSpec).toMatchObject({
        fit: 'contain',
        horizontalAlignment: 'center',
        verticalAlignment: 'center',
      });
      expect(result.record.input.structuredContextHash).toMatch(/^sha256:/u);
      const report = await readFile(join(artifactRoot, result.record.report!.relativePath), 'utf8');
      expect(report).toContain(result.record.input.structuredContextHash);
      expect(report).toContain('full validated typed evidence');
      const bundle = JSON.parse(
        await readFile(join(artifactRoot, result.record.designBundle!.relativePath), 'utf8'),
      );
      expect(bundle.structuredDesignContext.exactCopy[0]).toMatchObject({
        text: 'Blue component',
        provenance: 'owned e2e fixture',
      });
    }
  }, 30_000);
});
