import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { imageSize } from 'image-size';
import type { ArtifactStore, DesignProvider } from './providers.js';
import { designContractSchema, type DesignContract } from './schemas.js';

export interface LocalImageInput {
  imagePath: string;
  name?: string;
  spec?: {
    componentName?: string;
    route?: string;
    viewport?: { width: number; height: number; deviceScaleFactor?: number };
    theme?: 'light' | 'dark';
    locale?: string;
    ambiguities?: string[];
  };
}

export class LocalImageDesignProvider implements DesignProvider<LocalImageInput> {
  readonly name = 'local-image';
  constructor(private readonly artifacts: ArtifactStore) {}

  async normalize(input: LocalImageInput): Promise<DesignContract> {
    const source = resolve(input.imagePath);
    const bytes = await readFile(source);
    const dimensions = imageSize(bytes);
    const mediaType = mediaTypeFor(source);
    const reference = await this.artifacts.put(bytes, mediaType, source);
    const sourceHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const viewport = input.spec?.viewport ?? {
      width: dimensions.width,
      height: dimensions.height,
      deviceScaleFactor: 1,
    };
    return designContractSchema.parse({
      schemaVersion: '1.0',
      id: randomUUID(),
      name: input.name ?? input.spec?.componentName ?? 'Local image design',
      viewport,
      theme: input.spec?.theme ?? 'light',
      locale: input.spec?.locale ?? 'en-US',
      component: {
        name: input.spec?.componentName ?? 'FixtureCard',
        route: input.spec?.route ?? '/',
      },
      reference,
      provenance: {
        provider: this.name,
        source,
        capturedAt: new Date().toISOString(),
        sourceHash,
      },
      ambiguities: input.spec?.ambiguities ?? [],
    });
  }
}

function mediaTypeFor(path: string): string {
  const type = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }[extname(path).toLowerCase()];
  if (!type) throw new Error(`Unsupported image format: ${extname(path)}`);
  return type;
}
