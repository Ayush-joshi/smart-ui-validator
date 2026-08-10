import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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

  it('rejects reads outside the artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-artifacts-'));
    await expect(new LocalArtifactStore(root).read('../secret')).rejects.toThrow(
      /escapes store root/,
    );
  });

  it('rejects reads through links that leave the artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-artifacts-'));
    const outside = join(await mkdtemp(join(tmpdir(), 'smart-ui-outside-')), 'secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, 'linked-secret'));
    await expect(new LocalArtifactStore(root).read('linked-secret')).rejects.toThrow(
      /cannot be a symbolic link/,
    );
  });

  it('rejects a pre-existing object whose bytes do not match its address', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-artifacts-'));
    const expected = new TextEncoder().encode('expected');
    const digest = createHash('sha256').update(expected).digest('hex');
    const parent = join(root, 'objects', digest.slice(0, 2));
    await mkdir(parent, { recursive: true });
    await writeFile(join(parent, `${digest}.json`), 'corrupted');
    await expect(
      new LocalArtifactStore(root).put(expected, 'application/json', 'expected.json'),
    ).rejects.toThrow(/content hash check/);
  });

  it('uses owned extensions for generation artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-generation-artifacts-'));
    const store = new LocalArtifactStore(root);
    expect(
      (await store.put(new TextEncoder().encode('body{}'), 'text/css', 'styles.css')).relativePath,
    ).toMatch(/\.css$/);
    expect(
      (await store.put(new Uint8Array([80, 75]), 'application/zip', 'generated.zip')).relativePath,
    ).toMatch(/\.zip$/);
  });
});
