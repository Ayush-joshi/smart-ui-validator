import { mkdtemp, writeFile } from 'node:fs/promises';
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

  it.each([
    ['png', png(321, 123)],
    ['jpg', jpeg(640, 480)],
    ['webp', webp(777, 555)],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 700"/>')],
  ])('parses bounded %s dimensions without a general image parser', async (extension, bytes) => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-design-format-'));
    const imagePath = join(root, `reference.${extension}`);
    await writeFile(imagePath, bytes);
    const contract = await new LocalImageDesignProvider(
      new LocalArtifactStore(join(root, 'store')),
    ).normalize({ imagePath });
    const expected =
      extension === 'png'
        ? { width: 321, height: 123 }
        : extension === 'jpg'
          ? { width: 640, height: 480 }
          : extension === 'webp'
            ? { width: 777, height: 555 }
            : { width: 900, height: 700 };
    expect(contract.viewport).toMatchObject(expected);
  });

  it('rejects malformed headers and oversized local evidence before storing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-design-reject-'));
    const malformed = join(root, 'malformed.png');
    await writeFile(malformed, Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
    await expect(
      new LocalImageDesignProvider(
        new LocalArtifactStore(join(root, 'malformed-store')),
        100,
      ).normalize({ imagePath: malformed }),
    ).rejects.toThrow(/safely parse/u);

    const oversized = join(root, 'oversized.svg');
    await writeFile(oversized, Buffer.from('<svg/>'));
    await expect(
      new LocalImageDesignProvider(
        new LocalArtifactStore(join(root, 'oversized-store')),
        4,
      ).normalize({ imagePath: oversized }),
    ).rejects.toThrow(/no larger than 4 bytes/u);
  });
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8], 0);
  new DataView(bytes.buffer).setUint16(7, height);
  new DataView(bytes.buffer).setUint16(9, width);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(Buffer.from('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set(Buffer.from('WEBPVP8X'), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  setUint24Le(bytes, 24, width - 1);
  setUint24Le(bytes, 27, height - 1);
  return bytes;
}

function setUint24Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}
