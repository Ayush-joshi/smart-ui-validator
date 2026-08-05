import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalArtifactStore } from '../packages/core/src/index.js';

describe('LocalArtifactStore', () => {
  it('deduplicates unchanged content by hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-artifacts-'));
    const store = new LocalArtifactStore(root);
    const bytes = new TextEncoder().encode('same bytes');
    const first = await store.put(bytes, 'application/json', 'one.json');
    const second = await store.put(bytes, 'application/json', 'two.json');
    expect(second.hash).toBe(first.hash);
    expect(await store.readManifest()).toHaveLength(1);
    expect(await readFile(join(root, first.relativePath), 'utf8')).toBe('same bytes');
  });
});
