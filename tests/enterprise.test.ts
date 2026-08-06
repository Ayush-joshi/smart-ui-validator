import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AesGcmEncryptionProvider,
  FileAuditLog,
  StaticAuthorizationProvider,
  isolatedStorageRoot,
} from '../packages/core/src/index.js';

const context = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  repositoryId: 'repository-a',
  projectId: 'project-a',
};

describe('enterprise isolation and audit controls', () => {
  it('denies unassigned actions and derives non-overlapping opaque namespaces', () => {
    const auth = new StaticAuthorizationProvider({ 'tenant-a:user-a': ['inspect'] });
    expect(() => auth.assertAuthorized(context, 'inspect')).not.toThrow();
    expect(() => auth.assertAuthorized(context, 'repair')).toThrow(/not authorized/);
    expect(isolatedStorageRoot('/tmp/smart-ui-tenants', context)).not.toBe(
      isolatedStorageRoot('/tmp/smart-ui-tenants', { ...context, userId: 'user-b' }),
    );
    expect(isolatedStorageRoot('/tmp/smart-ui-tenants', context)).not.toContain('tenant-a');
  });

  it('binds encrypted data to its scope and verifies redacted audit chains', async () => {
    const encryption = new AesGcmEncryptionProvider(randomBytes(32));
    const encrypted = await encryption.encrypt(
      new TextEncoder().encode('private evidence'),
      context,
    );
    expect(new TextDecoder().decode(await encryption.decrypt(encrypted, context))).toBe(
      'private evidence',
    );
    await expect(encryption.decrypt(encrypted, { ...context, userId: 'user-b' })).rejects.toThrow();

    const path = join(await mkdtemp(join(tmpdir(), 'audit-')), 'events.jsonl');
    const audit = new FileAuditLog(path);
    await audit.append({
      actor: context,
      action: 'validate',
      outcome: 'succeeded',
      details: { token: 'secret-value' },
    });
    await audit.append({ actor: context, action: 'report', outcome: 'succeeded' });
    expect(await audit.verify()).toEqual({ valid: true, count: 2 });
    expect(JSON.stringify(await audit.read())).not.toContain('secret-value');
    await writeFile(
      path,
      (await (await import('node:fs/promises')).readFile(path, 'utf8')).replace(
        'validate',
        'tampered',
      ),
    );
    expect((await audit.verify()).valid).toBe(false);
  });
});
