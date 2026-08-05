import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalArtifactStore, LocalImageDesignProvider } from '../packages/core/src/index.js';

describe('LocalImageDesignProvider', () => {
  it('records dimensions, hash, media type and provenance', async () => {
    const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), 'smart-ui-design-')));
    const contract = await new LocalImageDesignProvider(store).normalize({
      imagePath: resolve('fixtures/react-app/design/reference.svg'),
      spec: { componentName: 'FixtureCard' },
    });
    expect(contract.viewport).toMatchObject({ width: 800, height: 600 });
    expect(contract.reference.mediaType).toBe('image/svg+xml');
    expect(contract.reference.hash).toMatch(/^sha256:/);
    expect(contract.provenance.source).toMatch(/reference\.svg$/);
  });
});
