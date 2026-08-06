import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AesGcmEncryptionProvider,
  LocalBackupManager,
  LocalScopedDataManager,
  RetentionManager,
  migrateConfig,
} from '../packages/core/src/index.js';

const scope = { tenantId: 'tenant', userId: 'user', repositoryId: 'repo' };

describe('operations and migrations', () => {
  it('migrates only the supported config version', () => {
    expect(migrateConfig({}).migratedFrom).toBe('unversioned');
    expect(migrateConfig({ schemaVersion: '1.0' }).migratedFrom).toBeNull();
    expect(() => migrateConfig({ schemaVersion: '2.0' })).toThrow(/unsupported/i);
  });

  it('creates an encrypted backup and restores it without overwriting', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'operations-'));
    const source = join(temporary, 'source');
    await (await import('node:fs/promises')).mkdir(source);
    await writeFile(join(source, 'memory.json'), 'governed data');
    const encryption = new AesGcmEncryptionProvider(randomBytes(32));
    const manager = new LocalBackupManager();
    const backup = await manager.create(source, join(temporary, 'backups'), scope, encryption);
    const restored = join(temporary, 'restored');
    await manager.restore(
      backup.root,
      restored,
      scope,
      { approved: true, actor: 'operator' },
      encryption,
    );
    expect(await readFile(join(restored, 'memory.json'), 'utf8')).toBe('governed data');
    await expect(
      manager.restore(
        backup.root,
        restored,
        scope,
        { approved: true, actor: 'operator' },
        encryption,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('purges expired evidence while preserving legal holds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retention-'));
    const expired = join(root, 'expired.json');
    const held = join(root, 'held.json');
    await writeFile(expired, 'old');
    await writeFile(held, 'held');
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(expired, old, old);
    await utimes(held, old, old);
    const result = await new RetentionManager().purgeExpired(root, {
      olderThan: new Date('2021-01-01T00:00:00Z'),
      legalHold: (path) => path === 'held.json',
    });
    expect(result).toEqual({ deleted: ['expired.json'], held: ['held.json'] });
  });

  it('exports and verifies approved scoped deletion while honoring holds', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'scoped-data-'));
    const source = join(temporary, 'tenant-scope');
    await (await import('node:fs/promises')).mkdir(source);
    await writeFile(join(source, 'delete.json'), 'delete me');
    await writeFile(join(source, 'held.json'), 'legal hold');
    const manager = new LocalScopedDataManager();
    const exported = await manager.export(source, join(temporary, 'exports'), scope);
    expect(exported.manifest.files).toHaveLength(2);
    const deleted = await manager.delete(
      source,
      { approved: true, actor: 'privacy-admin', scope },
      (path) => path === 'held.json',
    );
    expect(deleted).toEqual({
      deleted: ['delete.json'],
      held: ['held.json'],
      verified: true,
    });
  });
});
