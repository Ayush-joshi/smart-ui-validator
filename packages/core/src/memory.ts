import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { redactSensitiveText } from './security.js';

export const memoryScopeKindSchema = z.enum([
  'organization',
  'team',
  'user',
  'repository',
  'project',
  'component',
  'session',
  'task',
]);
export const memoryStateSchema = z.enum([
  'candidate',
  'confirmed',
  'rejected',
  'superseded',
  'expired',
]);
export const memoryLayerSchema = z.enum(['L0', 'L1', 'L2', 'L3']);
export const memorySensitivitySchema = z.enum(['public', 'internal', 'personal', 'sensitive']);

const explicitIdentitySchema = z
  .object({ tenantId: z.string().min(1), userId: z.string().min(1) })
  .strict();

export const memoryScopeSchema = z
  .object({ kind: memoryScopeKindSchema, id: z.string().min(1).max(512) })
  .strict();

export const memoryEvidenceSchema = z
  .object({
    kind: z.enum(['interaction', 'design', 'repository', 'browser', 'run', 'import']),
    summary: z.string().min(1).max(2_000),
    sourceVersion: z.string().min(1).max(256).optional(),
    artifactHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const memoryRecordSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().min(1),
    type: z.enum([
      'constraint',
      'preference',
      'component-mapping',
      'proven-fix',
      'episode',
      'profile',
    ]),
    layer: memoryLayerSchema,
    value: z.string().min(1).max(8_000),
    scope: memoryScopeSchema,
    selectors: z
      .object({
        repositoryId: z.string().min(1).optional(),
        projectId: z.string().min(1).optional(),
        componentId: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
      })
      .strict(),
    identity: explicitIdentitySchema,
    state: memoryStateSchema,
    confidence: z.number().min(0).max(1),
    promotionReason: z.string().min(1).max(1_000),
    evidence: z.array(memoryEvidenceSchema).min(1).max(50),
    creator: z.string().min(1).max(256),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastConfirmedAt: z.string().datetime().optional(),
    lastUsedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    sensitivity: memorySensitivitySchema,
    retention: z
      .object({
        policy: z.enum(['session', 'days', 'indefinite']),
        days: z.number().int().positive().optional(),
      })
      .strict(),
    consent: z
      .object({ granted: z.boolean(), recordedAt: z.string().datetime(), actor: z.string().min(1) })
      .strict(),
    conflictsWith: z.array(z.string()).default([]),
    supersedes: z.array(z.string()).default([]),
    supersededBy: z.string().optional(),
  })
  .strict();

export const memoryExportSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    exportedAt: z.string().datetime(),
    records: z.array(memoryRecordSchema),
  })
  .strict();

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryIdentity = z.infer<typeof explicitIdentitySchema>;

export interface MemoryContext extends MemoryIdentity {
  repositoryId: string;
  projectId?: string;
  componentId?: string;
  sessionId?: string;
  taskId?: string;
}

export interface RecallBudget {
  maxRecords: number;
  maxCharactersPerMemory: number;
  maxTotalCharacters: number;
}
export interface RecallResult {
  records: MemoryRecord[];
  context: string;
  characters: number;
  estimatedTokens: number;
  excluded: Array<{ id: string; reason: string }>;
}
export interface MemoryExplanation {
  record: MemoryRecord;
  eligible: boolean;
  reason: string;
  affectedDecision?: string;
  outrankedBy?: string;
}

export type GuidanceSource =
  | 'explicit-instruction'
  | 'pinned-design'
  | 'policy'
  | 'confirmed-project-team'
  | 'confirmed-user'
  | 'candidate';
export interface GuidanceCandidate {
  key: string;
  value: string;
  source: GuidanceSource;
  memoryId?: string;
}
export interface GuidanceDecision {
  key: string;
  value: string;
  source: GuidanceSource;
  memoryId?: string;
  outranked: GuidanceCandidate[];
}

/** Deterministically resolves current evidence before advisory memory. */
export function resolveGuidance(candidates: GuidanceCandidate[]): GuidanceDecision[] {
  const sourceRank: Record<GuidanceSource, number> = {
    'explicit-instruction': 600,
    'pinned-design': 500,
    policy: 400,
    'confirmed-project-team': 300,
    'confirmed-user': 200,
    candidate: 100,
  };
  const groups = new Map<string, GuidanceCandidate[]>();
  for (const candidate of candidates)
    groups.set(candidate.key, [...(groups.get(candidate.key) ?? []), candidate]);
  return [...groups.entries()].map(([key, entries]) => {
    const sorted = [...entries].sort((a, b) => sourceRank[b.source] - sourceRank[a.source]);
    const winner = sorted[0];
    if (!winner) throw new Error(`Missing guidance candidate for '${key}'.`);
    return {
      key,
      value: winner.value,
      source: winner.source,
      ...(winner.memoryId ? { memoryId: winner.memoryId } : {}),
      outranked: sorted.slice(1),
    };
  });
}

export interface MemoryProvider {
  recall(context: MemoryContext, budget: RecallBudget): Promise<RecallResult>;
  propose(
    input: Omit<
      MemoryRecord,
      | 'schemaVersion'
      | 'id'
      | 'state'
      | 'createdAt'
      | 'updatedAt'
      | 'lastConfirmedAt'
      | 'lastUsedAt'
      | 'conflictsWith'
      | 'supersedes'
    >,
  ): Promise<MemoryRecord>;
  confirm(id: string, scope?: MemoryScope): Promise<MemoryRecord>;
  reject(id: string): Promise<MemoryRecord>;
  reinforce(id: string): Promise<MemoryRecord>;
  supersede(id: string, replacement: MemoryRecord): Promise<MemoryRecord>;
  forget(id: string): Promise<boolean>;
  purgeSession(sessionId: string): Promise<number>;
  list(filter?: { scope?: MemoryScope; identity?: MemoryIdentity }): Promise<MemoryRecord[]>;
  show(id: string): Promise<MemoryRecord | null>;
  explain(id: string, context?: MemoryContext): Promise<MemoryExplanation | null>;
  export(filter?: {
    scope?: MemoryScope;
    identity?: MemoryIdentity;
  }): Promise<z.infer<typeof memoryExportSchema>>;
  import(value: unknown, dryRun: boolean): Promise<{ accepted: number; rejected: number }>;
  close?(): Promise<void>;
}

const forbiddenInstruction =
  /\b(run|execute|shell|commit|push|merge|deploy|send)\b.{0,40}\b(command|tool|message|permission)|\b(writable|allowlist|approval)\b.{0,30}\b(expand|bypass|ignore|grant)/i;
const binaryPayload = /(?:data:[^;]+;base64,|[A-Za-z0-9+/]{200,}={0,2})/;

export class LocalMemoryProvider implements MemoryProvider {
  private loaded = false;
  private records = new Map<string, MemoryRecord>();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly allowOrganizationScope = false,
    private readonly boundIdentity?: MemoryIdentity,
  ) {}

  async recall(context: MemoryContext, budget: RecallBudget): Promise<RecallResult> {
    this.assertBoundIdentity(context);
    await this.load();
    const now = this.now();
    let lifecycleChanged = false;
    for (const [id, record] of this.records) {
      if (record.state === 'confirmed' && record.expiresAt && new Date(record.expiresAt) <= now) {
        this.records.set(id, { ...record, state: 'expired', updatedAt: now.toISOString() });
        lifecycleChanged = true;
      }
    }
    const excluded: RecallResult['excluded'] = [];
    const eligible = [...this.records.values()].filter((record) => {
      const reason = exclusionReason(record, context, now);
      if (reason) excluded.push({ id: record.id, reason });
      return !reason;
    });
    eligible.sort(
      (a, b) =>
        precedence(b) - precedence(a) ||
        b.confidence - a.confidence ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    const selected: MemoryRecord[] = [];
    const lines: string[] = [];
    const seen = new Set<string>();
    let characters = 0;
    for (const record of eligible) {
      const key = `${record.type}\0${record.value}`;
      if (seen.has(key) || selected.length >= budget.maxRecords) continue;
      const compact = record.value.slice(0, budget.maxCharactersPerMemory);
      const line = `[untrusted-memory id=${record.id} scope=${record.scope.kind}:${record.scope.id}] ${compact}`;
      if (characters + line.length > budget.maxTotalCharacters) {
        excluded.push({ id: record.id, reason: 'recall-budget' });
        continue;
      }
      seen.add(key);
      selected.push(record);
      lines.push(line);
      characters += line.length;
    }
    const usedAt = now.toISOString();
    for (const record of selected)
      this.records.set(record.id, { ...record, lastUsedAt: usedAt, updatedAt: usedAt });
    if (selected.length || lifecycleChanged) await this.persist();
    return {
      records: selected,
      context: lines.join('\n'),
      characters,
      estimatedTokens: Math.ceil(characters / 4),
      excluded,
    };
  }

  async propose(input: Parameters<MemoryProvider['propose']>[0]): Promise<MemoryRecord> {
    this.assertBoundIdentity(input.identity);
    await this.load();
    const value = sanitizeMemoryValue(input.value);
    const timestamp = this.now().toISOString();
    const conflicts = [...this.records.values()].filter(
      (record) =>
        sameIdentity(record.identity, input.identity) &&
        record.scope.kind === input.scope.kind &&
        record.scope.id === input.scope.id &&
        record.type === input.type &&
        record.value !== value &&
        ['candidate', 'confirmed'].includes(record.state),
    );
    const expiresAt =
      input.expiresAt ??
      (input.retention.policy === 'days' && input.retention.days
        ? new Date(this.now().getTime() + input.retention.days * 86_400_000).toISOString()
        : undefined);
    const record = memoryRecordSchema.parse({
      ...input,
      value,
      ...(expiresAt ? { expiresAt } : {}),
      schemaVersion: '1.0',
      id: stableId(input, timestamp),
      state: 'candidate',
      createdAt: timestamp,
      updatedAt: timestamp,
      conflictsWith: conflicts.map((record) => record.id),
      supersedes: [],
    });
    for (const conflict of conflicts)
      this.records.set(conflict.id, {
        ...conflict,
        conflictsWith: [...new Set([...conflict.conflictsWith, record.id])],
        updatedAt: timestamp,
      });
    this.records.set(record.id, record);
    await this.persist();
    return record;
  }

  async confirm(id: string, scope?: MemoryScope): Promise<MemoryRecord> {
    const requestedScope = scope ?? (await this.show(id))?.scope;
    if (requestedScope?.kind === 'organization' && !this.allowOrganizationScope)
      throw new Error('Organization memories require an administrator-controlled provider.');
    return this.transition(id, (record, now) => ({
      ...record,
      ...(scope ? { scope } : {}),
      state: 'confirmed',
      lastConfirmedAt: now,
      updatedAt: now,
      consent: { ...record.consent, granted: true, recordedAt: now },
    }));
  }
  async reject(id: string): Promise<MemoryRecord> {
    return this.transition(id, (record, now) => ({ ...record, state: 'rejected', updatedAt: now }));
  }
  async reinforce(id: string): Promise<MemoryRecord> {
    return this.transition(id, (record, now) => ({
      ...record,
      confidence: Math.min(1, record.confidence + 0.05),
      lastConfirmedAt: now,
      updatedAt: now,
    }));
  }
  async supersede(id: string, replacement: MemoryRecord): Promise<MemoryRecord> {
    await this.load();
    const current = this.require(id);
    const now = this.now().toISOString();
    const next = memoryRecordSchema.parse({
      ...replacement,
      supersedes: [...new Set([...replacement.supersedes, id])],
    });
    this.records.set(id, {
      ...current,
      state: 'superseded',
      supersededBy: next.id,
      updatedAt: now,
    });
    this.records.set(next.id, next);
    await this.persist();
    return next;
  }
  async forget(id: string): Promise<boolean> {
    await this.load();
    const deleted = this.records.delete(id);
    if (deleted) await this.persist();
    return deleted;
  }
  async purgeSession(sessionId: string): Promise<number> {
    await this.load();
    let count = 0;
    for (const [id, record] of this.records)
      if (
        (!this.boundIdentity || sameIdentity(record.identity, this.boundIdentity)) &&
        (record.selectors.sessionId === sessionId ||
          (record.scope.kind === 'session' && record.scope.id === sessionId))
      ) {
        this.records.delete(id);
        count++;
      }
    if (count) await this.persist();
    return count;
  }
  async list(
    filter: { scope?: MemoryScope; identity?: MemoryIdentity } = {},
  ): Promise<MemoryRecord[]> {
    await this.load();
    if (filter.identity && this.boundIdentity && !sameIdentity(filter.identity, this.boundIdentity))
      return [];
    const identity = this.boundIdentity ?? filter.identity;
    return [...this.records.values()]
      .filter(
        (r) =>
          (!filter.scope ||
            (r.scope.kind === filter.scope.kind && r.scope.id === filter.scope.id)) &&
          (!identity || sameIdentity(r.identity, identity)),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async show(id: string): Promise<MemoryRecord | null> {
    await this.load();
    const record = this.records.get(id);
    if (record && this.boundIdentity && !sameIdentity(record.identity, this.boundIdentity))
      return null;
    return record ?? null;
  }
  async explain(id: string, context?: MemoryContext): Promise<MemoryExplanation | null> {
    const record = await this.show(id);
    if (!record) return null;
    const reason = context ? exclusionReason(record, context, this.now()) : undefined;
    return {
      record,
      eligible: !reason,
      reason: reason ?? 'Confirmed, in scope, unexpired, and identity-bound.',
      affectedDecision: record.lastUsedAt
        ? `Included as advisory recall at ${record.lastUsedAt}; the exact downstream decision is retained in the RunRecord.`
        : 'No downstream use has been recorded for this memory.',
      ...(reason ? { outrankedBy: explanationForExclusion(reason) } : {}),
    };
  }
  async export(
    filter: { scope?: MemoryScope; identity?: MemoryIdentity } = {},
  ): Promise<z.infer<typeof memoryExportSchema>> {
    return memoryExportSchema.parse({
      schemaVersion: '1.0',
      exportedAt: this.now().toISOString(),
      records: await this.list(filter),
    });
  }
  async import(value: unknown, dryRun: boolean): Promise<{ accepted: number; rejected: number }> {
    await this.load();
    const parsed = memoryExportSchema.safeParse(value);
    if (!parsed.success)
      return {
        accepted: 0,
        rejected: Array.isArray((value as { records?: unknown[] })?.records)
          ? (value as { records: unknown[] }).records.length || 1
          : 1,
      };
    for (const record of parsed.data.records) {
      this.assertBoundIdentity(record.identity);
      sanitizeMemoryValue(record.value);
      if (!dryRun) {
        this.records.set(record.id, record);
      }
    }
    if (!dryRun) {
      await this.persist();
    }
    return { accepted: parsed.data.records.length, rejected: 0 };
  }

  private async transition(
    id: string,
    update: (record: MemoryRecord, now: string) => MemoryRecord,
  ): Promise<MemoryRecord> {
    await this.load();
    const record = memoryRecordSchema.parse(update(this.require(id), this.now().toISOString()));
    this.records.set(id, record);
    await this.persist();
    return record;
  }
  private require(id: string): MemoryRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown memory '${id}'.`);
    this.assertBoundIdentity(record.identity);
    return record;
  }
  private assertBoundIdentity(identity: MemoryIdentity): void {
    if (this.boundIdentity && !sameIdentity(identity, this.boundIdentity))
      throw new Error('Memory identity does not match the authenticated provider identity.');
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = memoryExportSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      for (const record of parsed.records) this.records.set(record.id, record);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const data =
      JSON.stringify(
        {
          schemaVersion: '1.0',
          exportedAt: this.now().toISOString(),
          records: [...this.records.values()],
        },
        null,
        2,
      ) + '\n';
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export function resolveMemoryPath(targetRoot: string, requested = '.smart-ui/memory.json'): string {
  const root = resolve(targetRoot);
  const candidate = resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`))
    throw new Error('Memory path must remain inside the target repository.');
  return candidate;
}

function sanitizeMemoryValue(value: string): string {
  if (binaryPayload.test(value))
    throw new Error('Memory values cannot contain binary or base64 payloads.');
  if (forbiddenInstruction.test(value))
    throw new Error('Memory values cannot grant permissions or instruct tool use.');
  return redactSensitiveText(value, 8_000);
}
function stableId(
  input: { identity: MemoryIdentity; scope: MemoryScope; type: string; value: string },
  timestamp: string,
): string {
  return `mem_${createHash('sha256')
    .update(
      JSON.stringify([
        input.identity,
        input.scope,
        input.type,
        input.value,
        timestamp,
        randomUUID(),
      ]),
    )
    .digest('hex')
    .slice(0, 24)}`;
}
function sameIdentity(a: MemoryIdentity, b: MemoryIdentity): boolean {
  return a.tenantId === b.tenantId && a.userId === b.userId;
}
function exclusionReason(
  record: MemoryRecord,
  context: MemoryContext,
  now: Date,
): string | undefined {
  if (!sameIdentity(record.identity, context)) return 'identity-mismatch';
  if (record.state !== 'confirmed') return `state-${record.state}`;
  if (record.expiresAt && new Date(record.expiresAt) <= now) return 'expired';
  const s = record.selectors;
  if (s.repositoryId && s.repositoryId !== context.repositoryId) return 'repository-mismatch';
  if (s.projectId && s.projectId !== context.projectId) return 'project-mismatch';
  if (s.componentId && s.componentId !== context.componentId) return 'component-mismatch';
  if (s.sessionId && s.sessionId !== context.sessionId) return 'session-mismatch';
  if (s.taskId && s.taskId !== context.taskId) return 'task-mismatch';
  return undefined;
}
function precedence(record: MemoryRecord): number {
  const values: Record<MemoryRecord['scope']['kind'], number> = {
    organization: 80,
    repository: 80,
    project: 70,
    team: 70,
    user: 60,
    component: 75,
    session: 90,
    task: 100,
  };
  return values[record.scope.kind];
}

function explanationForExclusion(reason: string): string {
  if (reason.startsWith('state-'))
    return `The memory lifecycle state '${reason.slice(6)}' excludes it.`;
  if (reason === 'expired') return 'The configured expiry outranks stale remembered guidance.';
  if (reason === 'identity-mismatch') return 'The authenticated tenant/user boundary excludes it.';
  if (reason.endsWith('-mismatch'))
    return `The explicit ${reason.slice(0, -9)} identity or selector excludes it.`;
  return reason;
}
