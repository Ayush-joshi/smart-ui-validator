import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { SmartUiError } from './errors.js';
import { redactSensitiveValue } from './security.js';

const identityPartSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:@/-]+$/);
export const isolationContextSchema = z
  .object({
    tenantId: identityPartSchema,
    userId: identityPartSchema,
    repositoryId: identityPartSchema,
    projectId: identityPartSchema.optional(),
  })
  .strict();
export type IsolationContext = z.infer<typeof isolationContextSchema>;

export type AuthorizedAction =
  | 'inspect'
  | 'validate'
  | 'repair'
  | 'generate'
  | 'generation:export'
  | 'generation:delete'
  | 'memory:read'
  | 'memory:write'
  | 'baseline:approve'
  | 'audit:export'
  | 'data:export'
  | 'data:delete'
  | 'policy:admin';

export interface AuthorizationProvider {
  assertAuthorized(context: IsolationContext, action: AuthorizedAction): Promise<void> | void;
}

/** Deny-by-default role mapping for local or remote adapters. Authentication remains host-owned. */
export class StaticAuthorizationProvider implements AuthorizationProvider {
  constructor(private readonly assignments: Record<string, readonly AuthorizedAction[]>) {}

  assertAuthorized(context: IsolationContext, action: AuthorizedAction): void {
    const parsed = isolationContextSchema.parse(context);
    const key = `${parsed.tenantId}:${parsed.userId}`;
    if (!(this.assignments[key] ?? []).includes(action)) {
      throw new SmartUiError('POLICY_VIOLATION', `Actor is not authorized for '${action}'.`);
    }
  }
}

/** Derives opaque, non-overlapping storage namespaces without leaking tenant names in paths. */
export function isolatedStorageRoot(baseRoot: string, context: IsolationContext): string {
  const parsed = isolationContextSchema.parse(context);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
  return join(
    resolve(baseRoot),
    'tenants',
    digest(parsed.tenantId),
    'repositories',
    digest(parsed.repositoryId),
    'users',
    digest(parsed.userId),
    ...(parsed.projectId ? ['projects', digest(parsed.projectId)] : []),
  );
}

export const auditEventSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    actor: isolationContextSchema,
    action: z.string().min(1),
    outcome: z.enum(['allowed', 'denied', 'succeeded', 'failed']),
    runId: z.string().optional(),
    details: z.record(z.string(), z.unknown()),
    previousHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Append-only JSONL audit trail with a verifiable hash chain. */
export class FileAuditLog {
  constructor(private readonly path: string) {}

  async append(input: {
    actor: IsolationContext;
    action: string;
    outcome: AuditEvent['outcome'];
    runId?: string;
    details?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    const existing = await this.read();
    const previousHash = existing.at(-1)?.hash ?? `sha256:${'0'.repeat(64)}`;
    const body = {
      schemaVersion: '1.0' as const,
      id: randomUUID(),
      sequence: existing.length + 1,
      timestamp: new Date().toISOString(),
      actor: isolationContextSchema.parse(input.actor),
      action: input.action,
      outcome: input.outcome,
      ...(input.runId ? { runId: input.runId } : {}),
      details: (redactSensitiveValue(input.details ?? {}) ?? {}) as Record<string, unknown>,
      previousHash,
    };
    const hash = `sha256:${createHash('sha256').update(stableJson(body)).digest('hex')}`;
    const event = auditEventSchema.parse({ ...body, hash });
    await mkdir(dirname(resolve(this.path)), { recursive: true });
    await appendFile(resolve(this.path), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  }

  async read(): Promise<AuditEvent[]> {
    try {
      const text = await readFile(resolve(this.path), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => auditEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async verify(): Promise<{ valid: boolean; count: number; firstInvalidSequence?: number }> {
    const events = await this.read();
    let previousHash = `sha256:${'0'.repeat(64)}`;
    for (const event of events) {
      const { hash, ...body } = event;
      const expected = `sha256:${createHash('sha256').update(stableJson(body)).digest('hex')}`;
      if (event.previousHash !== previousHash || hash !== expected) {
        return { valid: false, count: events.length, firstInvalidSequence: event.sequence };
      }
      previousHash = hash;
    }
    return { valid: true, count: events.length };
  }
}

export interface EncryptionProvider {
  readonly name: string;
  encrypt(plaintext: Uint8Array, context: IsolationContext): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, context: IsolationContext): Promise<Uint8Array>;
}

/** AES-256-GCM integration path. Inject key material from a KMS/secret manager; never store it here. */
export class AesGcmEncryptionProvider implements EncryptionProvider {
  readonly name = 'aes-256-gcm';
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32)
      throw new SmartUiError('INVALID_INPUT', 'AES-256-GCM requires a 32-byte key.');
  }

  async encrypt(plaintext: Uint8Array, context: IsolationContext): Promise<Uint8Array> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(stableJson(isolationContextSchema.parse(context))));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Uint8Array.from(
      Buffer.concat([Buffer.from('SUI1'), iv, cipher.getAuthTag(), encrypted]),
    );
  }

  async decrypt(ciphertext: Uint8Array, context: IsolationContext): Promise<Uint8Array> {
    const bytes = Buffer.from(ciphertext);
    if (bytes.subarray(0, 4).toString() !== 'SUI1' || bytes.byteLength < 32) {
      throw new SmartUiError('INVALID_INPUT', 'Encrypted payload header is invalid.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(4, 16));
    decipher.setAAD(Buffer.from(stableJson(isolationContextSchema.parse(context))));
    decipher.setAuthTag(bytes.subarray(16, 32));
    return Uint8Array.from(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]));
  }
}

export interface MetricsProvider {
  increment(name: string, value?: number, attributes?: Record<string, string>): void;
  observe(name: string, value: number, attributes?: Record<string, string>): void;
}

export interface StructuredLogger {
  log(event: {
    level: 'debug' | 'info' | 'warn' | 'error';
    name: string;
    message: string;
    attributes?: Record<string, unknown>;
  }): void;
}

export class NoopStructuredLogger implements StructuredLogger {
  log(): void {}
}

export class NoopMetricsProvider implements MetricsProvider {
  increment(): void {}
  observe(): void {}
}

export function assertManagedPath(root: string, candidate: string): string {
  const managedRoot = resolve(root);
  const path = resolve(managedRoot, candidate);
  const rel = relative(managedRoot, path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `Managed data path escapes its namespace: ${candidate}`,
    );
  }
  return path;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
