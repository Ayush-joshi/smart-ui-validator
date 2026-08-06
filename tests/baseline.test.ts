import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalBaselineStore, type ArtifactRef } from '../packages/core/src/index.js';
import { EMPTY_HASH } from './helpers.js';

const artifact: ArtifactRef = {
  hash: EMPTY_HASH,
  mediaType: 'image/png',
  relativePath: 'objects/empty.png',
  byteLength: 0,
};
const identity = {
  tenantId: 'tenant-a',
  repositoryId: 'repository-a',
  component: 'Card',
  viewport: 'desktop',
  state: 'default',
};

describe('visual regression baselines', () => {
  it('never updates a baseline without explicit attributed approval', async () => {
    const store = new LocalBaselineStore(
      join(await mkdtemp(join(tmpdir(), 'baseline-')), 'manifest.json'),
    );
    await expect(
      store.approve(identity, artifact, { approved: false, actor: 'reviewer', reason: 'reviewed' }),
    ).rejects.toThrow(/explicit approval/i);
    expect((await store.review(identity, artifact)).status).toBe('missing');
    await store.approve(identity, artifact, {
      approved: true,
      actor: 'reviewer',
      reason: 'pixel diff reviewed',
    });
    expect((await store.review(identity, artifact)).status).toBe('matched');
    expect(Object.keys((await store.read()).entries)[0]).toMatch(/^[a-f0-9]{64}$/);
  });
});
