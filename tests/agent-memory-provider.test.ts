import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentMemoryProvider, LocalMemoryProvider } from '../packages/core/src/index.js';

describe('live Agent Memory adapter', () => {
  it('persists through the public SQLite VectorStore and hydrates a later provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smart-ui-agent-memory-'));
    const databasePath = join(directory, 'agent-memory.sqlite');
    const identity = { tenantId: 'tenant-a', userId: 'user-a' };
    const first = new AgentMemoryProvider(
      new LocalMemoryProvider(
        join(directory, 'governance-1.json'),
        () => new Date(),
        false,
        identity,
      ),
      { databasePath },
    );

    const status = await first.integrationStatus();
    expect(status.packageAvailable).toBe(true);
    expect(status.publicExports).toEqual(
      expect.arrayContaining(['StandaloneHostAdapter', 'TdaiCore', 'VectorStore', 'parseConfig']),
    );
    expect(status).toMatchObject({
      mode: 'agent-memory-sqlite',
      liveIntegrationVerified: true,
      degraded: false,
      limitation: null,
    });

    const candidate = await first.propose({
      type: 'preference',
      layer: 'L1',
      value: 'spacing-source=repository-tokens',
      scope: { kind: 'repository', id: 'repo-a' },
      selectors: { repositoryId: 'repo-a' },
      identity,
      confidence: 0.8,
      promotionReason: 'Integration test.',
      evidence: [{ kind: 'interaction', summary: 'Confirmed during review.' }],
      creator: 'user-a',
      sensitivity: 'internal',
      retention: { policy: 'indefinite' },
      consent: {
        granted: false,
        recordedAt: '2026-08-06T00:00:00.000Z',
        actor: 'user-a',
      },
    });
    await first.confirm(candidate.id);
    const raw = await first.propose({
      type: 'episode',
      layer: 'L0',
      value:
        'artifact-hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      scope: { kind: 'repository', id: 'repo-a' },
      selectors: { repositoryId: 'repo-a', sessionId: 'session-a' },
      identity,
      confidence: 0.6,
      promotionReason: 'Compact raw evidence reference.',
      evidence: [{ kind: 'run', summary: 'Raw run evidence reference.' }],
      creator: 'user-a',
      sensitivity: 'internal',
      retention: { policy: 'days', days: 7 },
      consent: {
        granted: false,
        recordedAt: '2026-08-06T00:00:00.000Z',
        actor: 'user-a',
      },
    });
    await first.confirm(raw.id);
    await first.close();

    const second = new AgentMemoryProvider(
      new LocalMemoryProvider(
        join(directory, 'governance-2.json'),
        () => new Date(),
        false,
        identity,
      ),
      { databasePath },
    );
    expect(await second.show(candidate.id)).toMatchObject({ state: 'confirmed', layer: 'L1' });
    expect(await second.show(raw.id)).toMatchObject({ state: 'confirmed', layer: 'L0' });
    const recalled = await second.recall(
      { ...identity, repositoryId: 'repo-a', sessionId: 'session-a' },
      { maxRecords: 5, maxCharactersPerMemory: 200, maxTotalCharacters: 1_000 },
    );
    expect(recalled.excluded).toEqual([]);
    expect(recalled.records.map((record) => record.id).sort()).toEqual(
      [candidate.id, raw.id].sort(),
    );
    expect(recalled.context).toContain('spacing-source=repository-tokens');
    expect(await second.forget(candidate.id)).toBe(true);
    expect(await second.forget(raw.id)).toBe(true);
    await second.close();

    const third = new AgentMemoryProvider(
      new LocalMemoryProvider(
        join(directory, 'governance-3.json'),
        () => new Date(),
        false,
        identity,
      ),
      { databasePath },
    );
    expect(await third.show(candidate.id)).toBeNull();
    expect(await third.show(raw.id)).toBeNull();
    await third.close();
  });
});
