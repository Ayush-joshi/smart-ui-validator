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
} from '../../packages/core/src/index.js';

const fixtureRoot = resolve('fixtures/react-app');
const url = 'http://127.0.0.1:4173';
let server: ReturnType<typeof spawn>;

beforeAll(async () => {
  server = spawn(
    'pnpm',
    ['exec', 'vite', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
    {
      cwd: fixtureRoot,
      stdio: 'ignore',
      shell: false,
    },
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* server is still starting */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('fixture server did not start');
});

afterAll(() => server?.kill('SIGTERM'));

describe('Phase 1 vertical slice', () => {
  it('normalizes, inspects, captures, stores, and reports without source writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-e2e-'));
    const store = new LocalArtifactStore(root);
    const spec = JSON.parse(await readFile(join(fixtureRoot, 'design/spec.json'), 'utf8'));
    const contract = await new LocalImageDesignProvider(store).normalize({
      imagePath: join(fixtureRoot, 'design/reference.svg'),
      spec,
    });
    const orchestrator = new SmartUiOrchestrator({
      framework: new ReactFrameworkAdapter(),
      coding: new MockCodingProvider(),
      browser: new PlaywrightBrowserProvider(),
      artifacts: store,
      policy: new LocalPolicy({ targetRoot: fixtureRoot, dryRun: true }),
      reporter: new HtmlReporter(store),
    });
    const result = await orchestrator.run({
      targetRoot: fixtureRoot,
      designContractPath: 'generated-in-test',
      contract,
      url,
    });
    expect(result.record.status).toBe('dry-run');
    expect(result.record.changedFiles).toEqual([]);
    expect(result.record.artifacts.some((item) => item.mediaType === 'image/png')).toBe(true);
    expect(result.report).toMatch(/\.html$/);
  });
});
