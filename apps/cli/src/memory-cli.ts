import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  AgentMemoryProvider,
  LocalMemoryProvider,
  memoryRecordSchema,
  memoryScopeKindSchema,
  resolveMemoryPath,
  type MemoryRecord,
  type MemoryProvider,
  type MemoryScope,
} from 'smart-ui-validator-core';

interface CommonOptions {
  target: string;
  store: string;
  tenant: string;
  user: string;
  json?: boolean;
  backend: string;
  agentDatabase: string;
}

export function registerMemoryCommands(program: Command, invocationRoot: string): void {
  const memory = program.command('memory').description('Governed preference memory operations');

  addCommon(memory.command('list').option('--scope <scope>', 'scope kind:id')).action(
    async (options: CommonOptions & { scope?: string }) => {
      print(
        await provider(options, invocationRoot).list({
          identity: identity(options),
          ...(options.scope ? { scope: parseScope(options.scope) } : {}),
        }),
        options.json,
      );
    },
  );

  addCommon(memory.command('show').argument('<id>')).action(
    async (id: string, options: CommonOptions) =>
      print(await required(options, id, invocationRoot), options.json),
  );

  addCommon(memory.command('explain').argument('<id>').option('--repository <id>')).action(
    async (id: string, options: CommonOptions & { repository?: string }) => {
      const explanation = await provider(options, invocationRoot).explain(id, {
        ...identity(options),
        repositoryId: options.repository ?? resolve(invocationRoot, options.target),
      });
      if (!explanation) throw new Error(`Unknown memory '${id}'.`);
      print(explanation, options.json);
    },
  );

  addCommon(memory.command('confirm').argument('<id>').option('--scope <scope>')).action(
    async (id: string, options: CommonOptions & { scope?: string }) =>
      print(
        await provider(options, invocationRoot).confirm(
          id,
          options.scope ? parseScope(options.scope) : undefined,
        ),
        options.json,
      ),
  );

  addCommon(memory.command('reject').argument('<id>')).action(
    async (id: string, options: CommonOptions) =>
      print(await provider(options, invocationRoot).reject(id), options.json),
  );

  addCommon(
    memory
      .command('propose')
      .requiredOption('--value <text>')
      .requiredOption('--scope <scope>', 'scope kind:id')
      .option('--repository <id>'),
  ).action(
    async (options: CommonOptions & { value: string; scope: string; repository?: string }) => {
      const now = new Date().toISOString();
      const scope = parseScope(options.scope);
      const record = await provider(options, invocationRoot).propose({
        type: 'preference',
        layer: 'L1',
        value: options.value,
        scope,
        selectors:
          scope.kind === 'user'
            ? {}
            : { repositoryId: options.repository ?? resolve(invocationRoot, options.target) },
        identity: identity(options),
        confidence: 0.7,
        promotionReason: 'Explicit CLI proposal pending user confirmation.',
        evidence: [{ kind: 'interaction', summary: 'Proposed explicitly through the memory CLI.' }],
        creator: options.user,
        sensitivity: 'internal',
        retention: { policy: 'indefinite' },
        consent: { granted: false, recordedAt: now, actor: options.user },
      });
      print(record, options.json);
    },
  );

  addCommon(memory.command('correct').argument('<id>').requiredOption('--value <text>')).action(
    async (id: string, options: CommonOptions & { value: string }) => {
      const store = provider(options, invocationRoot);
      const old = await requiredFrom(store, id);
      const now = new Date().toISOString();
      const candidate = await store.propose({
        ...proposalFields(old),
        value: options.value,
        promotionReason: `User correction superseding ${old.id}.`,
        evidence: [
          ...old.evidence,
          { kind: 'interaction', summary: `Corrected memory ${old.id}.` },
        ],
        consent: { granted: true, recordedAt: now, actor: options.user },
      });
      const confirmed = await store.confirm(candidate.id);
      print(await store.supersede(old.id, confirmed), options.json);
    },
  );

  addCommon(memory.command('forget').argument('<id>')).action(
    async (id: string, options: CommonOptions) =>
      print({ id, forgotten: await provider(options, invocationRoot).forget(id) }, options.json),
  );

  addCommon(memory.command('export').option('--scope <scope>')).action(
    async (options: CommonOptions & { scope?: string }) =>
      print(
        await provider(options, invocationRoot).export({
          identity: identity(options),
          ...(options.scope ? { scope: parseScope(options.scope) } : {}),
        }),
        true,
      ),
  );

  addCommon(
    memory.command('import').argument('<file>').option('--dry-run', 'validate only'),
  ).action(async (file: string, options: CommonOptions & { dryRun?: boolean }) => {
    const target = resolve(invocationRoot, options.target);
    const value = JSON.parse(await readFile(resolveMemoryPath(target, file), 'utf8'));
    print(
      await provider(options, invocationRoot).import(value, options.dryRun ?? false),
      options.json,
    );
  });

  addCommon(memory.command('purge-session').argument('<session-id>')).action(
    async (sessionId: string, options: CommonOptions) =>
      print(
        { sessionId, purged: await provider(options, invocationRoot).purgeSession(sessionId) },
        options.json,
      ),
  );
}

function addCommon(command: Command): Command {
  return command
    .requiredOption('--target <path>', 'repository root')
    .option('--store <path>', 'repository-relative memory store', '.smart-ui/memory.json')
    .option('--tenant <id>', 'tenant identity', 'local')
    .option('--user <id>', 'user identity', 'default')
    .option('--backend <backend>', 'local or agent-memory', 'local')
    .option(
      '--agent-database <path>',
      'repository-relative Agent Memory SQLite database',
      '.smart-ui/agent-memory.sqlite',
    )
    .option('--json', 'emit JSON');
}

function provider(options: CommonOptions, invocationRoot: string): MemoryProvider {
  const target = resolve(invocationRoot, options.target);
  const local = new LocalMemoryProvider(
    resolveMemoryPath(target, options.store),
    () => new Date(),
    false,
    identity(options),
  );
  if (options.backend === 'local') return local;
  if (options.backend !== 'agent-memory')
    throw new Error("Backend must be 'local' or 'agent-memory'.");
  return new AgentMemoryProvider(local, {
    databasePath: resolveMemoryPath(target, options.agentDatabase),
    identity: identity(options),
  });
}

function identity(options: CommonOptions): { tenantId: string; userId: string } {
  return { tenantId: options.tenant, userId: options.user };
}

function parseScope(value: string): MemoryScope {
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1)
    throw new Error('Scope must use kind:id syntax.');
  return {
    kind: memoryScopeKindSchema.parse(value.slice(0, separator)),
    id: value.slice(separator + 1),
  };
}

async function required(
  options: CommonOptions,
  id: string,
  invocationRoot: string,
): Promise<MemoryRecord> {
  return requiredFrom(provider(options, invocationRoot), id);
}

async function requiredFrom(store: MemoryProvider, id: string): Promise<MemoryRecord> {
  const record = await store.show(id);
  if (!record) throw new Error(`Unknown memory '${id}'.`);
  return record;
}

function proposalFields(record: MemoryRecord): Parameters<MemoryProvider['propose']>[0] {
  return {
    type: record.type,
    layer: record.layer,
    value: record.value,
    scope: record.scope,
    selectors: record.selectors,
    identity: record.identity,
    confidence: record.confidence,
    promotionReason: record.promotionReason,
    evidence: record.evidence,
    creator: record.creator,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    sensitivity: record.sensitivity,
    retention: record.retention,
    consent: record.consent,
    ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
  };
}

function print(value: unknown, json?: boolean): void {
  const parsed = memoryRecordSchema.safeParse(value);
  console.log(
    json || !parsed.success
      ? JSON.stringify(value, null, 2)
      : `${parsed.data.id} ${parsed.data.state}`,
  );
}
