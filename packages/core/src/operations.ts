import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { type Config, configSchema } from './config.js';
import type { EncryptionProvider, IsolationContext } from './enterprise.js';
import { assertManagedPath, isolationContextSchema } from './enterprise.js';
import { SmartUiError } from './errors.js';

export function migrateConfig(input: unknown): { config: Config; migratedFrom: string | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SmartUiError('INVALID_INPUT', 'Configuration must be an object.');
  }
  const value = input as Record<string, unknown>;
  const version = value.schemaVersion;
  if (version !== undefined && version !== '1.0') {
    throw new SmartUiError(
      'INVALID_INPUT',
      `Unsupported configuration schema version '${String(version)}'.`,
    );
  }
  return {
    config: configSchema.parse(value),
    migratedFrom: version === undefined ? 'unversioned' : null,
  };
}

export const backupManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    scope: isolationContextSchema,
    encrypted: z.boolean(),
    files: z.array(
      z
        .object({
          relativePath: z.string().min(1),
          hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          byteLength: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

/** Creates and restores explicit, hash-verified backups of a managed namespace. */
export class LocalBackupManager {
  async create(
    sourceRoot: string,
    backupRoot: string,
    scope: IsolationContext,
    encryption?: EncryptionProvider,
  ) {
    const source = resolve(sourceRoot);
    const destination = resolve(backupRoot, randomUUID());
    const files = await listFiles(source);
    const entries: z.infer<typeof backupManifestSchema>['files'] = [];
    for (const relativePath of files) {
      const bytes = await readFile(assertManagedPath(source, relativePath));
      const stored = encryption ? await encryption.encrypt(bytes, scope) : bytes;
      const target = assertManagedPath(destination, join('data', relativePath));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, stored, { mode: 0o600, flag: 'wx' });
      entries.push({ relativePath, hash: sha256(bytes), byteLength: bytes.byteLength });
    }
    const manifest = backupManifestSchema.parse({
      schemaVersion: '1.0',
      id: basename(destination),
      createdAt: new Date().toISOString(),
      scope,
      encrypted: Boolean(encryption),
      files: entries,
    });
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    return { root: destination, manifest };
  }

  async restore(
    backupRoot: string,
    destinationRoot: string,
    scope: IsolationContext,
    approval: { approved: boolean; actor: string },
    encryption?: EncryptionProvider,
  ) {
    if (!approval.approved || !approval.actor)
      throw new SmartUiError(
        'POLICY_VIOLATION',
        'Restore requires explicit approval and actor attribution.',
      );
    const backup = resolve(backupRoot);
    const manifest = backupManifestSchema.parse(
      JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')),
    );
    if (JSON.stringify(manifest.scope) !== JSON.stringify(isolationContextSchema.parse(scope))) {
      throw new SmartUiError('POLICY_VIOLATION', 'Backup scope does not match the restore scope.');
    }
    if (manifest.encrypted !== Boolean(encryption))
      throw new SmartUiError(
        'INVALID_INPUT',
        'Restore encryption provider does not match the backup.',
      );
    const destination = resolve(destinationRoot);
    const staged = `${destination}.${process.pid}.restore`;
    for (const entry of manifest.files) {
      const stored = await readFile(assertManagedPath(backup, join('data', entry.relativePath)));
      const bytes = encryption ? await encryption.decrypt(stored, scope) : stored;
      if (sha256(bytes) !== entry.hash || bytes.byteLength !== entry.byteLength) {
        throw new SmartUiError(
          'PROVIDER_FAILURE',
          `Backup hash verification failed: ${entry.relativePath}`,
        );
      }
      const target = assertManagedPath(staged, entry.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    }
    try {
      await stat(destination);
      throw new SmartUiError(
        'POLICY_VIOLATION',
        'Restore destination already exists; restore is intentionally non-overwriting.',
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await rename(staged, destination);
    return { restored: manifest.files.length, destination, backupId: manifest.id };
  }
}

export class RetentionManager {
  async purgeExpired(
    managedRoot: string,
    options: { olderThan: Date; legalHold?: (relativePath: string) => boolean },
  ): Promise<{ deleted: string[]; held: string[] }> {
    const root = resolve(managedRoot);
    const deleted: string[] = [];
    const held: string[] = [];
    for (const relativePath of await listFiles(root)) {
      if (relativePath === 'manifest.json') continue;
      if (options.legalHold?.(relativePath)) {
        held.push(relativePath);
        continue;
      }
      const path = assertManagedPath(root, relativePath);
      if ((await stat(path)).mtime < options.olderThan) {
        await unlink(path);
        deleted.push(relativePath);
      }
    }
    return { deleted, held };
  }
}

export class LocalScopedDataManager {
  async export(
    managedRoot: string,
    exportRoot: string,
    scope: IsolationContext,
    encryption?: EncryptionProvider,
  ) {
    return new LocalBackupManager().create(managedRoot, exportRoot, scope, encryption);
  }

  async delete(
    managedRoot: string,
    approval: { approved: boolean; actor: string; scope: IsolationContext },
    legalHold?: (relativePath: string) => boolean,
  ): Promise<{ deleted: string[]; held: string[]; verified: boolean }> {
    if (!approval.approved || !approval.actor) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        'Scoped deletion requires explicit approval and actor attribution.',
      );
    }
    isolationContextSchema.parse(approval.scope);
    const root = resolve(managedRoot);
    const deleted: string[] = [];
    const held: string[] = [];
    for (const relativePath of await listFiles(root)) {
      if (legalHold?.(relativePath)) {
        held.push(relativePath);
        continue;
      }
      await unlink(assertManagedPath(root, relativePath));
      deleted.push(relativePath);
    }
    const remaining = await listFiles(root);
    return {
      deleted,
      held,
      verified:
        remaining.length === held.length &&
        remaining.every((relativePath) => held.includes(relativePath)),
    };
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const queue = [''];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, current), { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return result;
      throw error;
    }
    for (const entry of entries) {
      const path = current ? join(current, entry.name) : entry.name;
      if (entry.isSymbolicLink() || (await lstat(join(root, path))).isSymbolicLink()) {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          `Managed backup data cannot contain symbolic links: ${path}`,
        );
      }
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) result.push(relative(root, join(root, path)));
    }
  }
  return result.sort();
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
