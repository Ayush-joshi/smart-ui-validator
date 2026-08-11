import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  generationRecordSchema,
  validateGeneratedBundle,
  type SvgGenerationInput,
} from '../packages/core/src/index.js';

const encoder = new TextEncoder();

describe('SVG generation Phase 1 core', () => {
  it('sanitizes, canonicalizes, extracts hierarchy, and resolves viewBox dimensions', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-'));
    const path = join(workspace, 'viewbox.svg');
    await writeFile(
      path,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><g fill="#123" transform="translate(2 3)"><rect width="20" height="10"/><text x="4" y="30" font-family="Arial" font-size="24">Hello &amp; SVG</text></g></svg>`,
    );
    const config = configSchema.parse({});
    const store = new LocalArtifactStore(join(workspace, 'artifacts'));
    const result = await new LocalSvgStructureProvider(store, config.generation.limits).inspect(
      input(workspace, path),
    );
    expect(result.bundle.viewport).toMatchObject({ width: 320, height: 180 });
    expect(result.bundle.sanitization).toMatchObject({ accepted: true, gradientCount: 1 });
    expect(result.bundle.scene.nodes.some((node) => node.text === 'Hello & SVG')).toBe(true);
    expect(result.bundle.scene.nodes.find((node) => node.text === 'Hello & SVG')).toMatchObject({
      computedStyle: { fill: '#123' },
      transform: 'translate(2 3)',
    });
    expect(result.bundle.semanticCandidates.some((candidate) => candidate.kind === 'heading')).toBe(
      true,
    );
    expect(result.sanitizedXml).toContain('Hello &amp; SVG');
    expect(result.sanitizedXmlWithoutText).not.toContain('<text');
    expect(result.bundle.originalInputHash).not.toBe(result.bundle.sanitizedHash);
  });

  it.each([
    ['script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['handler', '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="go()"/></svg>'],
    [
      'external URL',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://bad.test/a.png"/></svg>',
    ],
    ['CSS import', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "x.css";</style></svg>'],
    ['foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'],
    ['animation', '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="x"/></svg>'],
    [
      'processing instruction',
      '<?xml-stylesheet href="theme.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
    [
      'encoding mismatch',
      '<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
    [
      'entity',
      '<!DOCTYPE svg [<!ENTITY x "bad">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    ],
  ])('fails closed on unsafe %s content', async (_name, svg) => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-unsafe-'));
    const path = join(workspace, 'unsafe.svg');
    await writeFile(path, svg);
    const config = configSchema.parse({});
    const provider = new LocalSvgStructureProvider(
      new LocalArtifactStore(join(workspace, 'artifacts')),
      config.generation.limits,
    );
    await expect(provider.inspect(input(workspace, path))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: expect.objectContaining({ stoppedReason: 'unsafe-svg' }),
    });
  });

  it('removes external hyperlink targets while preserving visible linked content', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-link-cleanup-'));
    const path = join(workspace, 'linked.svg');
    await writeFile(
      path,
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><a href="https://example.test"><text x="4" y="24">Visible label</text></a></svg>',
    );
    const config = configSchema.parse({});
    const result = await new LocalSvgStructureProvider(
      new LocalArtifactStore(join(workspace, 'artifacts')),
      config.generation.limits,
    ).inspect(input(workspace, path));

    expect(result.sanitizedXml).toContain('<a>');
    expect(result.sanitizedXml).toContain('Visible label');
    expect(result.sanitizedXml).not.toContain('https://example.test');
    expect(result.bundle.sanitization.decisions).toContain(
      'Removed an external hyperlink target from <a>; its visible SVG contents were preserved.',
    );
  });

  it('enforces decoded and structural budgets before rendering', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-budget-'));
    const path = join(workspace, 'large.svg');
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"><g><rect/></g></svg>');
    const config = configSchema.parse({ generation: { limits: { maxNodes: 2 } } });
    await expect(
      new LocalSvgStructureProvider(
        new LocalArtifactStore(join(workspace, 'artifacts')),
        config.generation.limits,
      ).inspect(input(workspace, path)),
    ).rejects.toThrow(/NODE_COUNT/);
  });

  it('rejects an oversized byte payload before XML parsing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-byte-budget-'));
    const path = join(workspace, 'large.svg');
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const config = configSchema.parse({ generation: { limits: { maxSvgBytes: 8 } } });
    await expect(
      new LocalSvgStructureProvider(
        new LocalArtifactStore(join(workspace, 'artifacts')),
        config.generation.limits,
      ).inspect(input(workspace, path)),
    ).rejects.toThrow(/byte input budget/);
  });

  it('retains bounded embedded raster evidence and reports missing semantic alt evidence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-raster-'));
    const path = join(workspace, 'raster.svg');
    await writeFile(
      path,
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image width="1" height="1" href="data:image/png;base64,iVBORw0KGgo="/></svg>',
    );
    const config = configSchema.parse({});
    const result = await new LocalSvgStructureProvider(
      new LocalArtifactStore(join(workspace, 'artifacts')),
      config.generation.limits,
    ).inspect(input(workspace, path));
    expect(result.bundle.sanitization.embeddedImageCount).toBe(1);
    expect(result.bundle.uncertainties).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'EMBEDDED_RASTER_CONTENT' })]),
    );
  });

  it('produces stable exact and hybrid HTML/CSS without remote references', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-output-'));
    const path = join(workspace, 'basic.svg');
    await writeFile(
      path,
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#fff"/><text x="24" y="52" fill="#123" font-family="Arial" font-size="28">Semantic title</text><text x="24" y="90" fill="#123" font-family="Arial" font-size="16">Readable copy</text><rect x="170" y="116" width="120" height="40" rx="8" fill="#315efb"/><text x="190" y="142" fill="#fff" font-family="Arial" font-size="16">Continue</text><g fill="#123" font-family="Arial" font-size="14"><text x="20" y="168">First</text><text x="92" y="168">Second</text></g></svg>',
    );
    const config = configSchema.parse({});
    const inspection = await new LocalSvgStructureProvider(
      new LocalArtifactStore(join(workspace, 'artifacts')),
      config.generation.limits,
    ).inspect(input(workspace, path));
    const generator = new DeterministicHtmlGenerationProvider();
    const exactA = await generator.generate(
      { ...input(workspace, path), mode: 'exact' },
      inspection,
    );
    const exactB = await generator.generate(
      { ...input(workspace, path), mode: 'exact' },
      inspection,
    );
    const hybrid = await generator.generate(input(workspace, path), inspection);
    expect(exactA.files.map((file) => file.bytes)).toEqual(exactB.files.map((file) => file.bytes));
    expect(hybrid.finalMode).toBe('hybrid');
    const html = new TextDecoder().decode(
      hybrid.files.find((file) => file.relativePath === 'index.html')!.bytes,
    );
    expect(html).toContain('data-validation-id="svg-');
    expect(html).toContain('data-source-node-id=');
    expect(html).toContain('<button type="button"');
    expect(html).toContain('flex-direction:row');
    expect(html).not.toMatch(/(?:href|src)=["']https?:\/\//);
    expect(() => validateGeneratedBundle(hybrid, config.generation.limits)).not.toThrow();
  });

  it('rejects generated traversal and case collisions', () => {
    const config = configSchema.parse({});
    const base = {
      decisions: [],
      uncertainties: [],
      finalMode: 'exact' as const,
    };
    expect(() =>
      validateGeneratedBundle(
        {
          ...base,
          files: [
            file('index.html'),
            file('styles.css'),
            file('assets/../escape.svg', 'image/svg+xml'),
          ],
        },
        config.generation.limits,
      ),
    ).toThrow(/canonical|segment/);
    expect(() =>
      validateGeneratedBundle(
        {
          ...base,
          files: [
            file('index.html'),
            file('styles.css'),
            file('assets/Icon.svg', 'image/svg+xml'),
            file('assets/icon.svg', 'image/svg+xml'),
          ],
        },
        config.generation.limits,
      ),
    ).toThrow(/collides/);
    expect(() =>
      validateGeneratedBundle(
        {
          ...base,
          files: [file('index.html'), file('styles.css'), file('assets/%2e%2e/escape.svg')],
        },
        config.generation.limits,
      ),
    ).toThrow(/Invalid generated path/);
    expect(() =>
      validateGeneratedBundle(
        {
          ...base,
          files: [file('index.html', 'image/svg+xml'), file('styles.css')],
        },
        config.generation.limits,
      ),
    ).toThrow(/media type|extension/);
  });

  it('parses host-proposed HTML and CSS and rejects active, remote, or undeclared content', () => {
    const config = configSchema.parse({});
    const base = {
      decisions: [],
      uncertainties: [],
      finalMode: 'semantic' as const,
    };
    const bundle = (html: string, css = 'body { margin: 0; }') => ({
      ...base,
      files: [
        { ...file('index.html'), bytes: encoder.encode(html) },
        { ...file('styles.css'), bytes: encoder.encode(css) },
      ],
    });
    expect(() =>
      validateGeneratedBundle(
        bundle(
          '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><button type="button">Safe</button></body></html>',
        ),
        config.generation.limits,
      ),
    ).not.toThrow();
    expect(() =>
      validateGeneratedBundle(
        bundle('<!doctype html><html><body><img src="missing.png" onerror="go()"></body></html>'),
        config.generation.limits,
      ),
    ).toThrow(/event-handler/);
    expect(() =>
      validateGeneratedBundle(
        bundle(
          '<!doctype html><html><body><form action="https://bad.test"><button>Go</button></form></body></html>',
        ),
        config.generation.limits,
      ),
    ).toThrow(/external or unsafe/);
    expect(() =>
      validateGeneratedBundle(
        bundle('<!doctype html><html><body><img src="assets/missing.svg"></body></html>'),
        config.generation.limits,
      ),
    ).toThrow(/undeclared local file/);
    expect(() =>
      validateGeneratedBundle(
        bundle('<!doctype html><html><body></body></html>', '@import "https://bad.test/x.css";'),
        config.generation.limits,
      ),
    ).toThrow(/forbidden @import/);
    expect(() =>
      validateGeneratedBundle(
        bundle(
          '<!doctype html><html><body><img srcset="https://bad.test/remote.svg 1x, assets/local.svg 2x"></body></html>',
        ),
        config.generation.limits,
      ),
    ).toThrow(/external or unsafe/);
    expect(() =>
      validateGeneratedBundle(
        bundle(
          '<!doctype html><html><body></body></html>',
          'body { background-image: image-set("https://bad.test/a.png" 1x); }',
        ),
        config.generation.limits,
      ),
    ).toThrow(/external or unsafe/);
    expect(() =>
      validateGeneratedBundle(
        bundle('<!doctype html><html><body></body></html>', 'body { background: u\\72l(x); }'),
        config.generation.limits,
      ),
    ).toThrow(/escaped token/);

    const svgBundle = (svg: string) => ({
      ...bundle(
        '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><img src="assets/art.svg"></body></html>',
      ),
      files: [
        ...bundle(
          '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><img src="assets/art.svg"></body></html>',
        ).files,
        { ...file('assets/art.svg', 'image/svg+xml'), bytes: encoder.encode(svg) },
      ],
    });
    expect(() =>
      validateGeneratedBundle(
        svgBundle(
          '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="shape" d="M0 0h1v1z"/></defs><use href="#shape"/></svg>',
        ),
        config.generation.limits,
      ),
    ).not.toThrow();
    expect(() =>
      validateGeneratedBundle(
        svgBundle(
          '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://bad.test/a.png"/></svg>',
        ),
        config.generation.limits,
      ),
    ).toThrow(/external or unsafe/);
    expect(() =>
      validateGeneratedBundle(
        svgBundle('<?xml-stylesheet href="theme.css"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
        config.generation.limits,
      ),
    ).toThrow(/declaration or processing instruction/);
  });

  it('creates byte-for-byte reproducible ZIP archives', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-zip-'));
    const exporter = new ReproducibleGenerationExporter(workspace);
    const files = [
      { relativePath: 'styles.css', bytes: encoder.encode('body{}\n') },
      { relativePath: 'index.html', bytes: encoder.encode('<!doctype html>\n') },
    ];
    const first = await exporter.archive(files);
    const second = await exporter.archive([...files].reverse());
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(first.slice(0, 2))).toBe('PK');
  });

  it('validates generation records independently from validation RunRecord', () => {
    expect(() => generationRecordSchema.parse({ schemaVersion: '1.0' })).toThrow();
  });

  it('propagates cancellation before parsing and records a deterministic terminal state', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-svg-cancel-'));
    const path = join(workspace, 'screen.svg');
    await writeFile(
      path,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    const config = configSchema.parse({});
    const artifactRoot = join(workspace, 'artifacts', 'cancel-run');
    const store = new LocalArtifactStore(artifactRoot);
    const controller = new AbortController();
    controller.abort();
    const result = await new GenerationOrchestrator({
      structure: new LocalSvgStructureProvider(store, config.generation.limits),
      generator: new DeterministicHtmlGenerationProvider(),
      preview: new LoopbackGeneratedPreviewProvider(),
      browser: new PlaywrightBrowserProvider(),
      artifacts: store,
      reporter: new HtmlGenerationReporter(store),
      exporter: new ReproducibleGenerationExporter(workspace),
      config,
    }).run({ ...input(workspace, path), artifactRoot }, controller.signal);
    expect(result.record).toMatchObject({
      status: 'failed',
      stoppedReason: 'canceled',
      canceled: true,
      generatedFiles: [],
    });
  });
});

function input(workspaceRoot: string, svgPath: string): SvgGenerationInput {
  return {
    workspaceRoot,
    svgPath,
    artifactRoot: join(workspaceRoot, 'run-artifacts'),
    mode: 'hybrid',
    layout: 'responsive',
    rendering: {
      background: { kind: 'transparent' },
      locale: 'en-US',
      theme: 'light',
    },
    dryRun: false,
  };
}

function file(
  relativePath: string,
  mediaType = relativePath.endsWith('.css') ? 'text/css' : 'text/html',
) {
  return {
    relativePath,
    mediaType,
    bytes: encoder.encode('safe'),
    rationale: 'test',
    sourceNodeIds: [],
  };
}
