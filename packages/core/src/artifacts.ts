import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { ArtifactStore } from './providers.js';
import type { ArtifactRef } from './schemas.js';

export class LocalArtifactStore implements ArtifactStore {
  private readonly root: string;
  private readonly manifestPath: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.manifestPath = join(this.root, 'manifest.json');
  }

  async put(bytes: Uint8Array, mediaType: string, label: string): Promise<ArtifactRef> {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const extension = extensionFor(mediaType);
    const file = join(this.root, 'objects', digest.slice(0, 2), `${digest}${extension}`);
    await mkdir(join(this.root, 'objects', digest.slice(0, 2)), { recursive: true });
    try {
      await writeFile(file, bytes, { flag: 'wx' });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const ref: ArtifactRef = {
      hash: `sha256:${digest}`,
      mediaType,
      relativePath: relative(this.root, file),
      byteLength: bytes.byteLength,
    };
    await this.updateManifest(ref, label);
    return ref;
  }

  async read(relativePath: string): Promise<Uint8Array> {
    return readFile(join(this.root, relativePath));
  }

  async readManifest(): Promise<ArtifactRef[]> {
    try {
      const raw = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest;
      return Object.values(raw.artifacts).map((entry) => ({
        hash: entry.hash,
        mediaType: entry.mediaType,
        relativePath: entry.relativePath,
        byteLength: entry.byteLength,
      }));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async updateManifest(ref: ArtifactRef, label: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let manifest: Manifest = { schemaVersion: '1.0', artifacts: {} };
    try {
      manifest = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    manifest.artifacts[ref.hash] = { ...ref, label: basename(label) };
    const temp = `${this.manifestPath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temp, this.manifestPath);
  }
}

interface Manifest {
  schemaVersion: '1.0';
  artifacts: Record<string, ArtifactRef & { label: string }>;
}

function extensionFor(mediaType: string): string {
  return (
    {
      'image/png': '.png',
      'image/svg+xml': '.svg',
      'application/json': '.json',
      'text/html': '.html',
    }[mediaType] ?? '.bin'
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export async function readArtifactBytes(path: string): Promise<Uint8Array> {
  return readFile(path);
}
