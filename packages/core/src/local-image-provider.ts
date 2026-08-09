import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { SmartUiError } from './errors.js';
import { readImageDimensions } from './image-dimensions.js';
import type { ArtifactStore, DesignProvider } from './providers.js';
import { designContractSchema, type DesignContract } from './schemas.js';

import type { DesignElement } from './schemas.js';

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
    elements?: Array<Partial<DesignElement>>;
  };
}

export class LocalImageDesignProvider implements DesignProvider<LocalImageInput> {
  readonly name = 'local-image';
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly maxBinaryBytes = 20_000_000,
  ) {}

  async normalize(input: LocalImageInput): Promise<DesignContract> {
    const source = resolve(input.imagePath);
    const details = await stat(source);
    if (!details.isFile() || details.size > this.maxBinaryBytes) {
      throw new SmartUiError(
        'INVALID_INPUT',
        `Local design evidence must be a file no larger than ${this.maxBinaryBytes} bytes.`,
      );
    }
    const bytes = await readFile(source);
    const mediaType = mediaTypeFor(source);
    if (bytes.byteLength > this.maxBinaryBytes) {
      throw new SmartUiError(
        'INVALID_INPUT',
        `Local design evidence exceeds the ${this.maxBinaryBytes} byte budget.`,
      );
    }
    const dimensions =
      input.spec?.viewport?.width !== undefined && input.spec.viewport.height !== undefined
        ? undefined
        : readImageDimensions(bytes, mediaType);
    const reference = await this.artifacts.put(bytes, mediaType, source);
    const sourceHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const width = input.spec?.viewport?.width ?? dimensions?.width;
    const height = input.spec?.viewport?.height ?? dimensions?.height;
    if (width === undefined || height === undefined) {
      throw new SmartUiError(
        'INVALID_INPUT',
        'Could not resolve image dimensions, and no viewport was provided in the spec.',
      );
    }
    const viewport = {
      width,
      height,
      deviceScaleFactor: input.spec?.viewport?.deviceScaleFactor ?? 1,
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
      elements: input.spec?.elements ?? [],
      sourceEvidence: {
        assets: [],
        uncertainties:
          input.spec?.elements && input.spec.elements.length > 0
            ? []
            : [
                'A raster/image reference does not provide exact semantic, typography, accessibility, or element correspondence data without a sidecar specification.',
              ],
      },
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
