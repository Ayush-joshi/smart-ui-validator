import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HtmlReporter,
  LocalArtifactStore,
  LocalImageDesignProvider,
  LocalPolicy,
  MockCodingProvider,
  PlaywrightBrowserProvider,
  ReactFrameworkAdapter,
  SmartUiOrchestrator,
  type DesignContract,
  type RepairProvider,
} from '../../packages/core/src/index.js';

const fixtureRoot = resolve('fixtures/react-app');
const url = 'http://127.0.0.1:4173';
let server: ReturnType<typeof spawn>;

beforeAll(async () => {
  server = spawn(
    'pnpm',
    ['exec', 'vite', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
    { cwd: fixtureRoot, stdio: 'ignore', shell: false },
  );
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The fixture is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('fixture server did not start');
});

afterAll(() => server?.kill('SIGTERM'));

describe('Phase 2 real-browser fixture', () => {
  it('localizes intentional desktop errors and produces reproducible evidence', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'smart-ui-e2e-'));
    const store = new LocalArtifactStore(artifactRoot);
    const spec = JSON.parse(
      await readFile(join(fixtureRoot, 'design/intentional-spec.json'), 'utf8'),
    );
    const contract = await new LocalImageDesignProvider(store).normalize({
      imagePath: join(fixtureRoot, 'design/reference.svg'),
      spec,
    });
    const first = await validate(store, contract);
    const second = await validate(store, contract);
    const categories = new Set(first.record.passes[0]?.findings.map((finding) => finding.category));
    expect(categories).toEqual(
      new Set(['geometry', 'appearance', 'typography', 'assets', 'accessibility', 'raster']),
    );
    expect(first.record.stoppedReason).toBe('validation-only');
    expect(first.record.score).toBeLessThan(100);
    expect(first.record.passes[0]?.screenshot?.hash).toBe(
      second.record.passes[0]?.screenshot?.hash,
    );
    expect(first.record.passes[0]?.findings.map((finding) => finding.id)).toEqual(
      second.record.passes[0]?.findings.map((finding) => finding.id),
    );
    expect(first.record.targetArtifact.mediaType).toBe('image/svg+xml');
    expect(first.record.passes[0]).toMatchObject({
      screenshot: { mediaType: 'image/png' },
      diff: { mediaType: 'image/png' },
      overlay: { mediaType: 'image/png' },
    });
    expect(first.report).toMatch(/\.html$/);
    const reportHtml = await store.read(first.report!);
    expect(new TextDecoder().decode(reportHtml)).not.toContain('fonts.googleapis.com');
  });

  it('validates the fixture at a mobile viewport and detects responsive overflow/difference', async () => {
    const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), 'smart-ui-mobile-')));
    const spec = JSON.parse(
      await readFile(join(fixtureRoot, 'design/intentional-spec.json'), 'utf8'),
    );
    const desktop = await new LocalImageDesignProvider(store).normalize({
      imagePath: join(fixtureRoot, 'design/reference.svg'),
      spec,
    });
    const mobile: DesignContract = {
      ...desktop,
      id: `${desktop.id}-mobile`,
      viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    };
    const result = await validate(store, mobile);
    expect(result.record.inputs.url).toBe(url);
    expect(result.record.passes[0]?.findings.some((finding) => finding.category === 'raster')).toBe(
      true,
    );
  });
});

async function validate(store: LocalArtifactStore, contract: DesignContract) {
  const noRepair: RepairProvider = { name: 'validation-only', proposeRepair: async () => [] };
  return new SmartUiOrchestrator({
    framework: new ReactFrameworkAdapter(),
    coding: new MockCodingProvider(),
    repair: noRepair,
    browser: new PlaywrightBrowserProvider(),
    artifacts: store,
    policy: new LocalPolicy({ targetRoot: fixtureRoot, allowedEndpoints: [url] }),
    reporter: new HtmlReporter(store),
  }).run({
    targetRoot: fixtureRoot,
    designContractPath: 'generated-in-test',
    contract,
    url,
    repairEnabled: false,
  });
}
