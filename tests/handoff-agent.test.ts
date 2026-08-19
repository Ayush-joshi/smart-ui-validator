import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeterministicHtmlGenerationProvider,
  LocalArtifactStore,
  LocalSvgStructureProvider,
  getHandoffTask,
  listPendingHandoffTasks,
  loadConfig,
  prepareGenerationTask,
  readHandoffEvidencePage,
  submitHandoffGeneration,
  svgGenerationInputSchema,
} from '../packages/core/src/index.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function prepare(name: string) {
  const workspace = await mkdtemp(join(resolve('tests'), `.handoff-agent-${name}-`));
  temporaryPaths.push(workspace);
  const designPath = join(workspace, 'design.svg');
  await writeFile(
    designPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#fff"/><text x="8" y="24">Task title</text></svg>',
  );
  const prepared = await prepareGenerationTask({
    workspace,
    designPath,
    mode: 'hybrid',
    layout: 'responsive',
  });
  return { workspace, designPath, prepared };
}

describe('task-backed agent handoff', () => {
  it('lists, loads, and pages only declared hash-verified evidence', async () => {
    const { workspace, prepared } = await prepare('evidence');
    const pending = await listPendingHandoffTasks(workspace, 'generation');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      taskId: prepared.task.taskId,
      taskHash: prepared.task.taskHash,
      revision: 0,
      status: 'awaiting-author',
    });
    expect(await getHandoffTask(prepared.taskFile)).toEqual(pending[0]);

    const evidence = prepared.task.evidence[0]!;
    const page = await readHandoffEvidencePage({
      taskFile: prepared.taskFile,
      relativePath: evidence.relativePath,
      limit: 32,
    });
    expect(page).toMatchObject({ offset: 0, nextOffset: 32, hash: evidence.hash });
    expect(page.content).toContain('<svg');

    const evidencePath = join(prepared.taskRoot, evidence.relativePath);
    const original = await readFile(evidencePath, 'utf8');
    await writeFile(evidencePath, original.replace('Task title', 'Other title'));
    await expect(
      readHandoffEvidencePage({
        taskFile: prepared.taskFile,
        relativePath: evidence.relativePath,
      }),
    ).rejects.toThrow(/no longer matches/u);
  });

  it('submits through the immutable generation review and rejects a stale revision', async () => {
    const { workspace, designPath, prepared } = await prepare('submit');
    const config = await loadConfig(workspace);
    const artifactRoot = join(workspace, 'proposal-artifacts');
    const input = svgGenerationInputSchema.parse({
      workspaceRoot: workspace,
      svgPath: designPath,
      artifactRoot,
      mode: prepared.task.mode,
      layout: prepared.task.layout,
      structuredDesignContext: prepared.task.structuredDesignContext,
      presentationSpec: prepared.task.presentationSpec,
      rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
    });
    const inspected = await new LocalSvgStructureProvider(
      new LocalArtifactStore(artifactRoot),
      config.generation.limits,
    ).inspect(input);
    const proposal = await new DeterministicHtmlGenerationProvider().generate(input, inspected);
    const files = proposal.files.map((file) => ({
      relativePath: file.relativePath,
      content: new TextDecoder().decode(file.bytes),
    }));

    await expect(
      submitHandoffGeneration({
        taskFile: prepared.taskFile,
        taskHash: prepared.task.taskHash,
        revision: 1,
        authoringAgent: 'contract-test',
        files,
      }),
    ).rejects.toThrow(/revision 0/u);

    const reviewed = await submitHandoffGeneration({
      taskFile: prepared.taskFile,
      taskHash: prepared.task.taskHash,
      revision: 0,
      authoringAgent: 'contract-test',
      files,
    });
    expect(['awaiting-decision', 'revision-needed']).toContain(reviewed.state.status);
    expect(reviewed.state.attempts[0]).toMatchObject({ source: 'mcp', author: 'contract-test' });
    expect(reviewed.attempt).toBe(1);
    expect(reviewed.result.generation?.recordPath).toBeTruthy();
  }, 60_000);
});
