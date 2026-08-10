import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HeuristicRepairProvider,
  HostProposedRepairProvider,
  HtmlReporter,
  LocalArtifactStore,
  LocalPolicy,
  MockCodingProvider,
  PlaywrightBrowserProvider,
  SmartUiOrchestrator,
  type BrowserEvidence,
  type BrowserProvider,
  type ProposedChange,
  type RepairProvider,
} from '../packages/core/src/index.js';
import { browserElement, contract, designElement, evidence, PNG_BYTES } from './helpers.js';

describe('bounded repair coordinator', () => {
  it('runs a controlled repair that measurably converges', async () => {
    const harness = await createHarness();
    const css = join(harness.targetRoot, 'src/styles.css');
    await mkdir(join(harness.targetRoot, 'src'), { recursive: true });
    await writeFile(css, '.card { background: #ff0000; }');
    const browser: BrowserProvider = {
      name: 'file-aware-browser',
      capture: async () => {
        const current = await readFile(css, 'utf8');
        return evidence([
          browserElement({ backgroundColor: current.includes('#3d63dd') ? '#3d63dd' : '#ff0000' }),
        ]);
      },
    };
    const result = await harness.run({
      browser,
      repair: new HeuristicRepairProvider(),
      writableFiles: ['src/styles.css'],
      design: [designElement({ backgroundColor: '#3d63dd' })],
    });
    expect(result.record.stoppedReason).toBe('success');
    expect(result.record.passes.map((pass) => pass.score)).toEqual([expect.any(Number), 100]);
    expect(result.record.passes[0]!.score).toBeLessThan(100);
    expect(result.record.changedFiles).toEqual(['src/styles.css']);
    expect(await readFile(css, 'utf8')).toContain('#3d63dd');
    expect(Object.isFrozen(result.record.passes[0])).toBe(true);
    expect(Object.isFrozen(result.record.passes[0]?.findings)).toBe(true);
    expect(result.record.passes.every((pass) => typeof pass.diffPercent === 'number')).toBe(true);
  });

  it('retains a patch that improves raster mismatch before the binary raster check passes', async () => {
    const [target, before, after] = await Promise.all([
      screenshot('<style>html,body{margin:0;width:10px;height:10px;background:white}</style>'),
      screenshot('<style>html,body{margin:0;width:10px;height:10px;background:black}</style>'),
      screenshot(
        '<style>html,body{margin:0;width:10px;height:10px;background:linear-gradient(to right,white 0 50%,black 50%)}</style>',
      ),
    ]);
    const harness = await createHarness({}, target);
    const result = await harness.run({
      browser: scriptedBrowser([
        evidence([], { screenshot: before }),
        evidence([], { screenshot: after }),
      ]),
      repair: new HostProposedRepairProvider([
        { relativePath: 'src/value.txt', content: 'improved', rationale: 'reduce raster mismatch' },
      ]),
      writableFiles: ['src/value.txt'],
      design: [],
    });

    expect(result.record.passes[0]?.score).toBeLessThan(100);
    expect(result.record.passes.at(-1)?.score).toBe(result.record.passes[0]?.score);
    expect(result.record.passes[0]?.diffPercent).toBeGreaterThan(
      result.record.passes.at(-1)?.diffPercent ?? 100,
    );
    expect(result.record.changedFiles).toEqual(['src/value.txt']);
    expect(await readFile(join(harness.targetRoot, 'src/value.txt'), 'utf8')).toBe('improved');
  });

  it('stops and reverts repeated identical findings', async () => {
    const harness = await createHarness();
    const file = join(harness.targetRoot, 'src/value.txt');
    await mkdir(join(harness.targetRoot, 'src'), { recursive: true });
    await writeFile(file, 'user-content');
    const result = await harness.run({
      browser: scriptedBrowser([mismatching(), mismatching(), mismatching()]),
      repair: fixedRepair([{ relativePath: 'src/value.txt', content: 'patch', rationale: 'test' }]),
      writableFiles: ['src/value.txt'],
    });
    expect(result.record.stoppedReason).toBe('repeated-findings');
    expect(result.record.passes.some((pass) => pass.reverted)).toBe(true);
    expect(result.record.changedFiles).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('user-content');
  });

  it('stops on a different patch that does not improve the score', async () => {
    const harness = await createHarness();
    const result = await harness.run({
      browser: scriptedBrowser([
        evidence([browserElement({ backgroundColor: '#ff0000' })]),
        evidence([]),
        evidence([browserElement({ backgroundColor: '#ff0000' })]),
      ]),
      repair: fixedRepair([{ relativePath: 'src/value.txt', content: 'patch', rationale: 'test' }]),
      writableFiles: ['src/value.txt'],
      design: [designElement({ backgroundColor: '#3d63dd' })],
    });
    expect(result.record.stoppedReason).toBe('no-improvement');
    await expect(access(join(harness.targetRoot, 'src/value.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stops on a repeated patch hash after an improving pass', async () => {
    const harness = await createHarness();
    const change = { relativePath: 'src/value.txt', content: 'same patch', rationale: 'test' };
    const result = await harness.run({
      browser: scriptedBrowser([
        evidence([browserElement({ x: 99, width: 120, backgroundColor: '#ff0000' })]),
        evidence([browserElement({ x: 10, width: 120, backgroundColor: '#3d63dd' })]),
      ]),
      repair: fixedRepair([change]),
      writableFiles: ['src/value.txt'],
      design: [designElement({ backgroundColor: '#3d63dd' })],
    });
    expect(result.record.stoppedReason).toBe('repeated-patch');
  });

  it('stops at the configured patch limit after validating the last patch', async () => {
    const harness = await createHarness({ validation: { maxRepairPasses: 1 } });
    const result = await harness.run({
      browser: scriptedBrowser([
        evidence([browserElement({ x: 99, width: 120, backgroundColor: '#ff0000' })]),
        evidence([browserElement({ x: 10, width: 120, backgroundColor: '#3d63dd' })]),
      ]),
      repair: fixedRepair([{ relativePath: 'src/value.txt', content: 'patch', rationale: 'test' }]),
      writableFiles: ['src/value.txt'],
      design: [designElement({ backgroundColor: '#3d63dd' })],
    });
    expect(result.record.stoppedReason).toBe('maximum-passes');
    expect(result.record.changedFiles).toEqual(['src/value.txt']);
  });

  it('records no-changes and validation-only terminal states', async () => {
    const harness = await createHarness();
    const noChanges = await harness.run({
      browser: scriptedBrowser([mismatching()]),
      repair: fixedRepair([]),
    });
    expect(noChanges.record.stoppedReason).toBe('no-changes');
    const validation = await harness.run({
      browser: scriptedBrowser([mismatching()]),
      repair: fixedRepair([]),
      repairEnabled: false,
    });
    expect(validation.record.stoppedReason).toBe('validation-only');
  });

  it('rolls back existing and newly created files when repository checks regress', async () => {
    const harness = await createHarness({
      policy: {
        allowedCommands: [{ executable: 'node', args: ['-e', 'process.exit(1)'] }],
      },
      commands: { typecheck: { executable: 'node', args: ['-e', 'process.exit(1)'] } },
    });
    const existing = join(harness.targetRoot, 'src/existing.txt');
    await mkdir(join(harness.targetRoot, 'src'), { recursive: true });
    await writeFile(existing, 'pre-existing user work');
    const result = await harness.run({
      browser: scriptedBrowser([mismatching()]),
      repair: fixedRepair([
        { relativePath: 'src/existing.txt', content: 'broken', rationale: 'test rollback' },
        { relativePath: 'src/new.txt', content: 'broken', rationale: 'test rollback' },
      ]),
      writableFiles: ['src/existing.txt', 'src/new.txt'],
      allowedCommands: [{ executable: 'node', args: ['-e', 'process.exit(1)'] }],
    });
    expect(result.record.stoppedReason).toBe('test-regression');
    expect(await readFile(existing, 'utf8')).toBe('pre-existing user work');
    await expect(access(join(harness.targetRoot, 'src/new.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on policy violations without writing', async () => {
    const harness = await createHarness();
    const result = await harness.run({
      browser: scriptedBrowser([mismatching()]),
      repair: fixedRepair([
        { relativePath: 'src/blocked.txt', content: 'no', rationale: 'blocked' },
      ]),
    });
    expect(result.record.status).toBe('failed');
    expect(result.record.stoppedReason).toBe('policy-violation');
    await expect(access(join(harness.targetRoot, 'src/blocked.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('honors cancellation before browser or repair work', async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    controller.abort();
    const browser: BrowserProvider = {
      name: 'must-not-run',
      capture: async () => {
        throw new Error('capture should not run');
      },
    };
    const result = await harness.run({
      browser,
      repair: fixedRepair([]),
      signal: controller.signal,
    });
    expect(result.record.status).toBe('succeeded');
    expect(result.record.stoppedReason).toBe('canceled');
    expect(result.record.passes).toEqual([]);
  });
});

async function createHarness(
  config: Record<string, unknown> = {},
  referenceBytes: Uint8Array = PNG_BYTES,
) {
  const targetRoot = await mkdtemp(join(tmpdir(), 'smart-ui-target-'));
  const artifactRoot = await mkdtemp(join(tmpdir(), 'smart-ui-artifacts-'));
  if (Object.keys(config).length > 0) {
    await writeFile(join(targetRoot, 'smart-ui.config.json'), JSON.stringify(config));
  }
  const store = new LocalArtifactStore(artifactRoot);
  const reference = await store.put(referenceBytes, 'image/png', 'target.png');
  return {
    targetRoot,
    async run(options: {
      browser: BrowserProvider;
      repair: RepairProvider;
      writableFiles?: string[];
      allowedCommands?: Array<{ executable: string; args: string[] }>;
      design?: ReturnType<typeof designElement>[];
      repairEnabled?: boolean;
      signal?: AbortSignal;
    }) {
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
            componentLocations: ['src'],
          }),
        },
        coding: new MockCodingProvider(),
        repair: options.repair,
        browser: options.browser,
        artifacts: store,
        policy: new LocalPolicy({
          targetRoot,
          writableFiles: options.writableFiles ?? [],
          allowedCommands: options.allowedCommands ?? [],
          allowedEndpoints: ['http://127.0.0.1:4173'],
        }),
        reporter: new HtmlReporter(store),
      });
      return orchestrator.run({
        targetRoot,
        designContractPath: 'test-contract.json',
        contract: contract(
          reference,
          options.design ?? [designElement({ backgroundColor: '#3d63dd' })],
        ),
        url: 'http://127.0.0.1:4173',
        ...(options.repairEnabled === undefined ? {} : { repairEnabled: options.repairEnabled }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
  };
}

async function screenshot(content: string): Promise<Uint8Array> {
  const captured = await new PlaywrightBrowserProvider().capture({
    url: `data:text/html,${encodeURIComponent(content)}`,
    viewport: { width: 10, height: 10, deviceScaleFactor: 1 },
    timeoutMs: 10_000,
    locale: 'en-US',
    theme: 'light',
    allowedEndpoints: [],
    blockExternalNetwork: true,
    evidenceLimits: {
      maxElements: 10,
      maxTextLength: 100,
      maxConsoleMessages: 10,
      maxFailedRequests: 10,
      maxArtifactBytes: 1_000_000,
    },
  });
  return captured.screenshot;
}

function mismatching(): BrowserEvidence {
  return evidence([browserElement({ backgroundColor: '#ff0000' })]);
}

function scriptedBrowser(sequence: BrowserEvidence[]): BrowserProvider {
  let index = 0;
  return {
    name: 'scripted-browser',
    capture: async () => sequence[Math.min(index++, sequence.length - 1)]!,
  };
}

function fixedRepair(changes: ProposedChange[]): RepairProvider {
  return { name: 'fixed-repair', proposeRepair: async () => changes };
}
