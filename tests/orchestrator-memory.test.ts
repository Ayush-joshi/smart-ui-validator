import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HtmlReporter,
  LocalArtifactStore,
  LocalMemoryProvider,
  LocalPolicy,
  MockCodingProvider,
  SmartUiOrchestrator,
  type RepairProvider,
} from '../packages/core/src/index.js';
import { contract, evidence, PNG_BYTES } from './helpers.js';

describe('optional orchestrator memory', () => {
  it('records bounded advisory recall when enabled without changing policy', async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), 'smart-ui-memory-run-'));
    const artifactRoot = await mkdtemp(join(tmpdir(), 'smart-ui-memory-artifacts-'));
    const artifacts = new LocalArtifactStore(artifactRoot);
    const reference = await artifacts.put(PNG_BYTES, 'image/png', 'target.png');
    const memory = new LocalMemoryProvider(join(targetRoot, '.smart-ui', 'memory.json'));
    const candidate = await memory.propose({
      type: 'preference',
      layer: 'L1',
      value: 'spacing-source=repository-tokens',
      scope: { kind: 'repository', id: targetRoot },
      selectors: { repositoryId: targetRoot },
      identity: { tenantId: 'local', userId: 'developer' },
      confidence: 0.8,
      promotionReason: 'Test confirmation.',
      evidence: [{ kind: 'interaction', summary: 'Confirmed in a previous run.' }],
      creator: 'developer',
      sensitivity: 'internal',
      retention: { policy: 'indefinite' },
      consent: {
        granted: false,
        recordedAt: '2026-08-06T00:00:00.000Z',
        actor: 'developer',
      },
    });
    await memory.confirm(candidate.id);
    const repair: RepairProvider = { name: 'none', proposeRepair: async () => [] };
    const result = await new SmartUiOrchestrator({
      framework: {
        framework: 'react',
        inspect: async () => ({
          root: targetRoot,
          framework: 'react',
          buildSystem: 'vite',
          packageManager: 'pnpm',
          styling: [],
          testFrameworks: [],
          componentLocations: [],
        }),
      },
      coding: new MockCodingProvider(),
      repair,
      browser: { name: 'fixed', capture: async () => evidence() },
      artifacts,
      policy: new LocalPolicy({
        targetRoot,
        writableFiles: [],
        allowedCommands: [],
        allowedEndpoints: ['http://127.0.0.1:4173'],
      }),
      reporter: new HtmlReporter(artifacts),
      memory,
    }).run({
      targetRoot,
      designContractPath: 'design.json',
      contract: contract(reference),
      url: 'http://127.0.0.1:4173',
      repairEnabled: false,
      memoryContext: { tenantId: 'local', userId: 'developer', repositoryId: targetRoot },
      memoryBudget: { maxRecords: 1, maxCharactersPerMemory: 40, maxTotalCharacters: 200 },
    });

    const decision = result.record.decisions.find((item) => item.kind === 'memory-recall');
    expect(decision).toBeDefined();
    expect(JSON.parse(decision!.message)).toMatchObject({
      advisoryOnly: true,
      memoryIds: [candidate.id],
    });
    expect(result.record.changedFiles).toEqual([]);
  });
});
