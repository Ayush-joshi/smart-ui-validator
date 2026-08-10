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
  ReproducibleGenerationExporter,
  SmartUiError,
  configSchema,
  type BrowserProvider,
  type GeneratedPreviewProvider,
  type HtmlGenerationProvider,
  type SvgGenerationInput,
  type SvgStructureProvider,
} from '../packages/core/src/index.js';
import { evidence } from './helpers.js';

describe('SVG generation cancellation boundaries', () => {
  it.each(['parsing', 'generation', 'preview'] as const)(
    'turns a timeout during %s into a deterministic canceled record',
    async (stage) => {
      const fixture = await generationFixture(`timeout-${stage}`);
      const reached: string[] = [];
      const waitingStructure: SvgStructureProvider = {
        name: 'waiting-structure',
        version: '1.0.0',
        async inspect(_input, signal) {
          reached.push('parsing');
          await waitForAbort(signal);
          throw new SmartUiError('PROVIDER_FAILURE', 'Parsing timed out.');
        },
      };
      const waitingGenerator: HtmlGenerationProvider = {
        name: 'waiting-generator',
        version: '1.0.0',
        async generate(_input, _inspection, signal) {
          reached.push('generation');
          await waitForAbort(signal);
          throw new SmartUiError('PROVIDER_FAILURE', 'Generation timed out.');
        },
      };
      const waitingPreview: GeneratedPreviewProvider = {
        async serve(_bundle, signal) {
          reached.push('preview');
          await waitForAbort(signal);
          throw new SmartUiError('PROVIDER_FAILURE', 'Preview timed out.');
        },
      };
      const result = await orchestrator(fixture.workspace, {
        ...(stage === 'parsing' ? { structure: waitingStructure } : {}),
        ...(stage === 'generation' ? { generator: waitingGenerator } : {}),
        ...(stage === 'preview' ? { preview: waitingPreview } : {}),
      }).run({ ...fixture.input, timeoutMs: 1_000 });

      expect(reached).toContain(stage);
      expect(result.record).toMatchObject({
        status: 'failed',
        stoppedReason: 'canceled',
        canceled: true,
      });
    },
  );

  it('honors cancellation immediately before deterministic comparison', async () => {
    const fixture = await generationFixture('comparison-cancel');
    const controller = new AbortController();
    let captures = 0;
    const browser: BrowserProvider = {
      async capture() {
        captures += 1;
        if (captures === 2) controller.abort();
        return evidence([]);
      },
    };
    const preview: GeneratedPreviewProvider = {
      async serve() {
        return {
          url: 'http://127.0.0.1:1/index.html',
          origin: 'http://127.0.0.1:1',
          close: async () => {},
        };
      },
    };
    const result = await orchestrator(fixture.workspace, { browser, preview }).run(
      fixture.input,
      controller.signal,
    );

    expect(captures).toBe(2);
    expect(result.record).toMatchObject({
      status: 'failed',
      stoppedReason: 'canceled',
      canceled: true,
    });
  });
});

async function generationFixture(name: string) {
  const workspace = await mkdtemp(join(tmpdir(), `smart-ui-svg-${name}-`));
  const svgPath = join(workspace, 'screen.svg');
  await writeFile(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const input: SvgGenerationInput = {
    workspaceRoot: workspace,
    svgPath,
    artifactRoot: join(workspace, '.smart-ui', 'run'),
    mode: 'exact',
    layout: 'fixed',
    rendering: {
      background: { kind: 'transparent' },
      locale: 'en-US',
      theme: 'light',
    },
    dryRun: false,
  };
  return { workspace, input };
}

function orchestrator(
  workspace: string,
  overrides: Partial<{
    structure: SvgStructureProvider;
    generator: HtmlGenerationProvider;
    preview: GeneratedPreviewProvider;
    browser: BrowserProvider;
  }> = {},
) {
  const config = configSchema.parse({});
  const store = new LocalArtifactStore(join(workspace, '.smart-ui', 'run'));
  const unavailableBrowser: BrowserProvider = {
    async capture() {
      throw new Error('Browser must not be reached in this boundary test.');
    },
  };
  const unavailablePreview: GeneratedPreviewProvider = {
    async serve() {
      throw new Error('Preview must not be reached in this boundary test.');
    },
  };
  return new GenerationOrchestrator({
    structure:
      overrides.structure ?? new LocalSvgStructureProvider(store, config.generation.limits),
    generator: overrides.generator ?? new DeterministicHtmlGenerationProvider(),
    preview: overrides.preview ?? unavailablePreview,
    browser: overrides.browser ?? unavailableBrowser,
    artifacts: store,
    reporter: new HtmlGenerationReporter(store),
    exporter: new ReproducibleGenerationExporter(workspace),
    config,
  });
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
