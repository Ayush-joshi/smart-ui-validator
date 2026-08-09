import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSmartUiMcpServer, MCP_TOOL_DEFINITIONS } from '../apps/mcp-server/src/server.js';

const closers: Array<() => Promise<void>> = [];
const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('stable host-neutral MCP contract', () => {
  it('discovers versioned tools, resources, prompts, annotations, and structured results', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSmartUiMcpServer();
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(
      () => client.close(),
      () => server.close(),
    );

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      MCP_TOOL_DEFINITIONS.map(([name]) => name).sort(),
    );
    expect(
      tools.tools.find((tool) => tool.name === 'inspect_project')?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(tools.tools.find((tool) => tool.name === 'repair_component')?.annotations).toMatchObject(
      { readOnlyHint: false, destructiveHint: true },
    );
    expect(tools.tools.some((tool) => tool.name.includes('shell'))).toBe(false);
    expect((await client.listResources()).resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: 'smart-ui://capabilities' }),
        expect.objectContaining({ uri: 'smart-ui://workflow-guide' }),
      ]),
    );
    const workflow = await client.readResource({ uri: 'smart-ui://workflow-guide' });
    expect(workflow.contents[0]).toMatchObject({
      mimeType: 'text/markdown',
      text: expect.stringContaining('Reuse that exact artifactRoot'),
    });
    expect((await client.listPrompts()).prompts).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'implement-and-validate' })]),
    );

    const response = await client.callTool({
      name: 'inspect_project',
      arguments: { targetRoot: resolve('fixtures/angular-app') },
    });
    expect(response.structuredContent).toMatchObject({ framework: 'angular' });

    const workflowRoot = await mkdtemp(join(resolve('tests'), '.mcp-workflow-'));
    temporaryPaths.push(workflowRoot);
    const workflowArtifactRoot = join(workflowRoot, '.smart-ui', 'artifacts');
    const workflowContractPath = join(workflowRoot, '.smart-ui', 'design-contract.json');
    const workflowManifestPath = join(workflowRoot, '.smart-ui', 'workflow.json');
    await writeFile(
      join(workflowRoot, 'package.json'),
      JSON.stringify({ dependencies: { '@angular/core': '20.0.0' } }),
    );
    await writeFile(
      join(workflowRoot, 'reference.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>',
    );
    await mkdir(join(workflowRoot, '.smart-ui'), { recursive: true });
    await writeFile(
      workflowManifestPath,
      JSON.stringify({
        schemaVersion: '1.0',
        targetRoot: workflowRoot,
        route: 'http://127.0.0.1:4200/',
        design: { imagePath: join(workflowRoot, 'reference.svg') },
        artifactRoot: workflowArtifactRoot,
        contractPath: workflowContractPath,
        componentId: 'LoginComponent',
        memory: { enabled: false },
      }),
    );
    const prepared = await client.callTool({
      name: 'prepare_workflow',
      arguments: { manifestPath: workflowManifestPath },
    });
    expect(prepared.structuredContent).toMatchObject({
      ready: true,
      normalized: true,
      project: { framework: 'angular' },
      design: { viewport: { width: 20, height: 10 }, rasterOnly: true },
      planArguments: { targetRoot: workflowRoot, component: 'LoginComponent' },
      validationArguments: {
        targetRoot: workflowRoot,
        designContractPath: workflowContractPath,
        artifactRoot: workflowArtifactRoot,
        responseDetail: 'compact',
      },
    });
    expect(
      (
        await client.callTool({
          name: 'prepare_workflow',
          arguments: { manifestPath: workflowManifestPath },
        })
      ).structuredContent,
    ).toMatchObject({ ready: true, normalized: false });

    const denied = await client.callTool({
      name: 'inspect_project',
      arguments: { targetRoot: resolve('/') },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('MCP workspace root') }),
      ]),
    );
  });

  it('persists a confirmed governed memory through Agent Memory and preserves identity scope', async () => {
    const targetRoot = await mkdtemp(join(resolve('tests'), '.mcp-memory-'));
    temporaryPaths.push(targetRoot);
    await writeFile(
      join(targetRoot, 'smart-ui.config.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        memory: {
          enabled: true,
          learningEnabled: true,
          backend: 'agent-memory',
        },
      }),
    );
    await writeFile(
      join(targetRoot, 'reference.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="white"/></svg>',
    );

    const connect = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createSmartUiMcpServer();
      const client = new Client({ name: 'memory-test', version: '1.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      closers.push(
        () => client.close(),
        () => server.close(),
      );
      return client;
    };

    const identity = { targetRoot, tenantId: 'local', userId: 'test-user' };
    const first = await connect();
    const normalized = await first.callTool({
      name: 'normalize_design',
      arguments: {
        imagePath: join(targetRoot, 'reference.svg'),
        artifactRoot: join(targetRoot, '.smart-ui', 'artifacts'),
        contractPath: join(targetRoot, 'design-contract.json'),
      },
    });
    expect(normalized.structuredContent).toMatchObject({
      viewport: { width: 2, height: 2 },
      contractPath: join(targetRoot, 'design-contract.json'),
      artifactRoot: join(targetRoot, '.smart-ui', 'artifacts'),
      nextAction: expect.stringContaining('same artifactRoot'),
    });
    expect(
      JSON.parse(await readFile(join(targetRoot, 'design-contract.json'), 'utf8')),
    ).toMatchObject({ viewport: { width: 2, height: 2 } });
    const status = await first.callTool({ name: 'memory_status', arguments: identity });
    expect(status.structuredContent).toMatchObject({
      enabled: true,
      learningEnabled: true,
      backend: 'agent-memory',
      integration: { liveIntegrationVerified: true, degraded: false },
    });
    const empty = await first.callTool({ name: 'list_memories', arguments: identity });
    expect(empty.structuredContent).toEqual({ memories: [] });

    const proposed = await first.callTool({
      name: 'propose_memory',
      arguments: {
        ...identity,
        approved: true,
        value: 'Preserve existing Angular form behavior during visual-only login styling changes.',
        scope: { kind: 'repository', id: targetRoot },
        repositoryId: targetRoot,
        componentId: 'LoginComponent',
        promotionReason: 'Explicitly selected for the MCP persistence demonstration.',
        evidenceSummary: 'The user requested an end-to-end governed-memory demonstration.',
      },
    });
    expect(proposed.structuredContent).toMatchObject({
      memory: { state: 'candidate', consent: { granted: false } },
    });
    const memoryId = (proposed.structuredContent as { memory: { id: string } }).memory.id;

    const confirmed = await first.callTool({
      name: 'confirm_memory',
      arguments: { ...identity, id: memoryId, approved: true },
    });
    expect(confirmed.structuredContent).toMatchObject({
      memory: { id: memoryId, state: 'confirmed', consent: { granted: true } },
    });

    await rm(join(targetRoot, '.smart-ui', 'memory.json'));
    const second = await connect();
    const rehydrated = await second.callTool({ name: 'list_memories', arguments: identity });
    expect(rehydrated.structuredContent).toMatchObject({
      memories: [{ id: memoryId, state: 'confirmed' }],
    });
    const isolated = await second.callTool({
      name: 'list_memories',
      arguments: { ...identity, userId: 'different-user' },
    });
    expect(isolated.isError, JSON.stringify(isolated.content)).toBeFalsy();
    expect(isolated.structuredContent).toEqual({ memories: [] });

    const explanation = await second.callTool({
      name: 'explain_memory',
      arguments: {
        ...identity,
        id: memoryId,
        repositoryId: targetRoot,
        componentId: 'LoginComponent',
      },
    });
    expect(explanation.structuredContent).toMatchObject({
      explanation: { eligible: true, record: { id: memoryId } },
    });

    const forgotten = await second.callTool({
      name: 'forget_memory',
      arguments: { ...identity, id: memoryId, approved: true },
    });
    expect(forgotten.structuredContent).toEqual({ id: memoryId, forgotten: true });
  });
});
