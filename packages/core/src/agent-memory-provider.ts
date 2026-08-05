import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  VectorStore,
  type L0Record as AgentL0Record,
  type MemoryRecord as AgentRecord,
} from 'agent-memory';
import type {
  MemoryContext,
  MemoryExplanation,
  MemoryIdentity,
  MemoryProvider,
  MemoryRecord,
  MemoryScope,
  RecallBudget,
  RecallResult,
} from './memory.js';

const SMART_UI_PREFIX = 'SMART_UI_MEMORY_V1:';

export interface AgentMemoryIntegrationStatus {
  packageAvailable: boolean;
  publicExports: string[];
  mode: 'agent-memory-sqlite';
  liveIntegrationVerified: boolean;
  degraded: boolean;
  limitation: string | null;
}

export interface AgentMemoryProviderOptions {
  databasePath: string;
}

/**
 * Governed Smart UI provider backed by Agent Memory's public SQLite VectorStore.
 *
 * Smart UI retains authority for lifecycle, identity, scope, consent, precedence,
 * and recall budgets. Compact validated records are mirrored to Agent Memory L1;
 * startup hydration proves Agent Memory is durable rather than an incidental sink.
 */
export class AgentMemoryProvider implements MemoryProvider {
  private store: VectorStore | undefined;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly governance: MemoryProvider,
    private readonly options: AgentMemoryProviderOptions,
  ) {}

  async integrationStatus(): Promise<AgentMemoryIntegrationStatus> {
    try {
      await this.initialize();
      const packageName: string = 'agent-memory';
      const module = (await import(packageName)) as Record<string, unknown>;
      const publicExports = Object.keys(module).sort();
      const required = ['StandaloneHostAdapter', 'TdaiCore', 'VectorStore', 'parseConfig'];
      const missing = required.filter((name) => !publicExports.includes(name));
      const degraded = this.store?.isDegraded() ?? true;
      return {
        packageAvailable: true,
        publicExports,
        mode: 'agent-memory-sqlite',
        liveIntegrationVerified: missing.length === 0 && !degraded,
        degraded,
        limitation:
          missing.length > 0
            ? `Missing required public exports: ${missing.join(', ')}.`
            : degraded
              ? 'Agent Memory VectorStore initialized in degraded mode.'
              : null,
      };
    } catch (error) {
      return {
        packageAvailable: false,
        publicExports: [],
        mode: 'agent-memory-sqlite',
        liveIntegrationVerified: false,
        degraded: true,
        limitation: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async recall(context: MemoryContext, budget: RecallBudget): Promise<RecallResult> {
    await this.initialize();
    return this.governance.recall(context, budget);
  }

  async propose(input: Parameters<MemoryProvider['propose']>[0]): Promise<MemoryRecord> {
    await this.initialize();
    return this.persist(await this.governance.propose(input));
  }

  async confirm(id: string, scope?: MemoryScope): Promise<MemoryRecord> {
    await this.initialize();
    return this.persist(await this.governance.confirm(id, scope));
  }

  async reject(id: string): Promise<MemoryRecord> {
    await this.initialize();
    return this.persist(await this.governance.reject(id));
  }

  async reinforce(id: string): Promise<MemoryRecord> {
    await this.initialize();
    return this.persist(await this.governance.reinforce(id));
  }

  async supersede(id: string, replacement: MemoryRecord): Promise<MemoryRecord> {
    await this.initialize();
    const next = await this.governance.supersede(id, replacement);
    const original = await this.governance.show(id);
    if (original) await this.persist(original);
    return this.persist(next);
  }

  async forget(id: string): Promise<boolean> {
    await this.initialize();
    const record = await this.governance.show(id);
    const forgotten = await this.governance.forget(id);
    if (forgotten && record)
      await (record.layer === 'L0' ? this.store?.deleteL0(id) : this.store?.deleteL1(id));
    return forgotten;
  }

  async purgeSession(sessionId: string): Promise<number> {
    await this.initialize();
    const records = (await this.governance.list()).filter(
      (record) =>
        record.selectors.sessionId === sessionId ||
        (record.scope.kind === 'session' && record.scope.id === sessionId),
    );
    const purged = await this.governance.purgeSession(sessionId);
    if (records.length) {
      const l1Ids = records.filter((record) => record.layer !== 'L0').map((record) => record.id);
      const l0Ids = records.filter((record) => record.layer === 'L0').map((record) => record.id);
      if (l1Ids.length) await this.store?.deleteL1Batch(l1Ids);
      for (const id of l0Ids) await this.store?.deleteL0(id);
    }
    return purged;
  }

  async list(filter?: { scope?: MemoryScope; identity?: MemoryIdentity }): Promise<MemoryRecord[]> {
    await this.initialize();
    return this.governance.list(filter);
  }

  async show(id: string): Promise<MemoryRecord | null> {
    await this.initialize();
    return this.governance.show(id);
  }

  async explain(id: string, context?: MemoryContext): Promise<MemoryExplanation | null> {
    await this.initialize();
    return this.governance.explain(id, context);
  }

  async export(filter?: { scope?: MemoryScope; identity?: MemoryIdentity }) {
    await this.initialize();
    return this.governance.export(filter);
  }

  async import(value: unknown, dryRun: boolean): Promise<{ accepted: number; rejected: number }> {
    await this.initialize();
    const result = await this.governance.import(value, dryRun);
    if (!dryRun && result.accepted > 0)
      for (const record of await this.governance.list()) await this.persist(record);
    return result;
  }

  async close(): Promise<void> {
    await this.ready;
    this.store?.close();
    this.store = undefined;
    this.ready = undefined;
  }

  private initialize(): Promise<void> {
    this.ready ??= this.initializeOnce();
    return this.ready;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(dirname(this.options.databasePath), { recursive: true });
    const store = new VectorStore(this.options.databasePath, 0, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    const result = await store.init({ provider: 'none', model: 'none' });
    if (store.isDegraded()) {
      store.close();
      throw new Error(
        `Agent Memory VectorStore failed to initialize: ${result.reason ?? 'unknown'}`,
      );
    }
    this.store = store;
    const records = [
      ...(await store.queryL1Records()).map((row) => decodeRecord(row.content)),
      ...(await store.getAllL0Texts()).map((row) => decodeRecord(row.message_text)),
    ].filter((record): record is MemoryRecord => record !== null);
    if (records.length)
      await this.governance.import(
        { schemaVersion: '1.0', exportedAt: new Date().toISOString(), records },
        false,
      );
  }

  private async persist(record: MemoryRecord): Promise<MemoryRecord> {
    if (!this.store) throw new Error('Agent Memory VectorStore is not initialized.');
    const stored =
      record.layer === 'L0'
        ? await this.store.upsertL0(encodeL0Record(record), undefined)
        : await this.store.upsertL1(encodeRecord(record), undefined);
    if (!stored) throw new Error(`Agent Memory failed to persist '${record.id}'.`);
    return record;
  }
}

function encodeL0Record(record: MemoryRecord): AgentL0Record {
  return {
    id: record.id,
    sessionKey: `${record.identity.tenantId}:${record.identity.userId}:${record.selectors.repositoryId ?? record.scope.id}`,
    sessionId: record.selectors.sessionId ?? record.selectors.taskId ?? record.id,
    role: 'system',
    messageText: `${SMART_UI_PREFIX}${JSON.stringify(record)}`,
    recordedAt: record.createdAt,
    timestamp: new Date(record.createdAt).getTime(),
  };
}

function encodeRecord(record: MemoryRecord): AgentRecord {
  return {
    id: record.id,
    content: `${SMART_UI_PREFIX}${JSON.stringify(record)}`,
    type:
      record.type === 'episode' || record.type === 'proven-fix'
        ? 'episodic'
        : record.type === 'preference' || record.type === 'profile'
          ? 'persona'
          : 'instruction',
    priority: Math.round(record.confidence * 100),
    scene_name: `smart-ui:${record.scope.kind}`,
    source_message_ids: record.evidence.map(
      (evidence, index) => evidence.artifactHash ?? `${record.id}:evidence:${index}`,
    ),
    metadata: {},
    timestamps: [record.createdAt, record.updatedAt],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sessionKey: `${record.identity.tenantId}:${record.identity.userId}:${record.selectors.repositoryId ?? record.scope.id}`,
    sessionId: record.selectors.sessionId ?? record.selectors.taskId ?? record.id,
  };
}

function decodeRecord(content: string): MemoryRecord | null {
  if (!content.startsWith(SMART_UI_PREFIX)) return null;
  try {
    return JSON.parse(content.slice(SMART_UI_PREFIX.length)) as MemoryRecord;
  } catch {
    return null;
  }
}
