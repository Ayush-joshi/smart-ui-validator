import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AngularFrameworkAdapter,
  HtmlReporter,
  LocalArtifactStore,
  LocalImageDesignProvider,
  LocalPolicy,
  MockCodingProvider,
  PlaywrightBrowserProvider,
  SmartUiOrchestrator,
  type DesignContract,
  type RepairProvider,
} from '../../packages/core/src/index.js';

const fixtureRoot = resolve('fixtures/angular-app');
const url = 'http://127.0.0.1:4273';
let server: ReturnType<typeof spawn>;

beforeAll(async () => {
  server = spawn('pnpm', ['exec', 'ng', 'serve', '--host', '127.0.0.1', '--port', '4273'], {
    cwd: fixtureRoot,
    stdio: 'ignore',
    shell: false,
  });
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Angular is still compiling.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error('Angular fixture server did not start');
}, 30_000);

afterAll(() => server?.kill('SIGTERM'));

describe('Phase 4 Angular real-browser fixture', () => {
  it('normalizes owned evidence and validates native Angular desktop, mobile, and focus state', async () => {
    const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), 'smart-ui-angular-e2e-')));
    const contract = await new LocalImageDesignProvider(store).normalize({
      imagePath: join(fixtureRoot, 'design/reference.svg'),
      spec: JSON.parse(await readFile(join(fixtureRoot, 'design/spec.json'), 'utf8')),
    });
    const desktop = await validate(store, contract);
    const mobile = await validate(store, {
      ...contract,
      id: `${contract.id}-mobile`,
      viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    });
    const focused = await validate(store, contract, {
      name: 'focus',
      selector: '[data-validation-id="angular-action"]',
    });
    expect(desktop.record.status).toBe('succeeded');
    expect(mobile.record.status).toBe('succeeded');
    expect(focused.record.status).toBe('succeeded');
    expect(
      desktop.record.decisions.find((decision) => decision.kind === 'component-reuse')?.message,
    ).toContain('FixtureCardComponent');
    expect(
      focused.record.passes[0]?.findings.some((finding) =>
        finding.message.includes('document-language'),
      ),
    ).toBe(false);
    expect(desktop.report).toMatch(/\.html$/);
  });
});

async function validate(
  store: LocalArtifactStore,
  contract: DesignContract,
  interaction?: { name: 'focus'; selector: string },
) {
  const noRepair: RepairProvider = { name: 'validation-only', proposeRepair: async () => [] };
  return new SmartUiOrchestrator({
    framework: new AngularFrameworkAdapter(),
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
    ...(interaction ? { interaction } : {}),
  });
}
