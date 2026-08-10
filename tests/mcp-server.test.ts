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
    expect(tools.tools.find((tool) => tool.name === 'inspect_svg')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(
      tools.tools.find((tool) => tool.name === 'export_generation')?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.tools.some((tool) => tool.name.includes('shell'))).toBe(false);
    expect((await client.listResources()).resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: 'smart-ui://capabilities' }),
        expect.objectContaining({ uri: 'smart-ui://workflow-guide' }),
        expect.objectContaining({ uri: 'smart-ui://svg-generation-guide' }),
      ]),
    );
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uriTemplate: 'smart-ui://generation-context/{generationId}/{cursor}',
        }),
      ]),
    );
    const workflow = await client.readResource({ uri: 'smart-ui://workflow-guide' });
    expect(workflow.contents[0]).toMatchObject({
      mimeType: 'text/markdown',
      text: expect.stringContaining('Reuse that exact artifactRoot'),
    });
    expect((await client.listPrompts()).prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'implement-and-validate' }),
        expect.objectContaining({ name: 'generate-from-svg' }),
      ]),
    );
    const capabilities = await client.readResource({ uri: 'smart-ui://capabilities' });
    expect(JSON.parse(String(capabilities.contents[0]!.text))).toMatchObject({
      generation: {
        enabled: true,
        modes: ['exact', 'hybrid', 'semantic'],
        exportApproval: 'separate-exact-manifest',
      },
    });

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

    const contract = JSON.parse(await readFile(workflowContractPath, 'utf8')) as {
      reference: Record<string, unknown>;
    };
    const runPath = join(workflowRoot, '.smart-ui', 'paged-findings.run.json');
    await writeFile(
      runPath,
      JSON.stringify({
        schemaVersion: '1.0',
        id: 'paged-findings',
        status: 'succeeded',
        startedAt: '2026-08-10T00:00:00.000Z',
        completedAt: '2026-08-10T00:00:01.000Z',
        targetRoot: workflowRoot,
        designContract: workflowContractPath,
        inputs: { url: 'http://127.0.0.1:4200', designId: 'design' },
        decisions: [],
        targetArtifact: contract.reference,
        artifacts: [contract.reference],
        changedFiles: [],
        timingsMs: { total: 1 },
        warnings: [],
        failures: [],
        provenance: { tool: 'smart-ui', version: '0.4.2' },
        score: 50,
        stoppedReason: 'validation-only',
        passes: [
          {
            passIndex: 0,
            findings: [
              {
                id: 'width',
                category: 'geometry',
                severity: 'error',
                confidence: 1,
                targetDomLocator: '[data-validation-id="card"]',
                expected: 320,
                actual: 300,
                delta: 20,
                message: 'width mismatch',
                suggestedRepairCategory: 'size',
                evidenceArtifacts: [contract.reference],
              },
              {
                id: 'padding',
                category: 'geometry',
                severity: 'warning',
                confidence: 0.9,
                targetDomLocator: '[data-validation-id="card"]',
                expected: 24,
                actual: 16,
                delta: 8,
                message: 'padding mismatch',
                suggestedRepairCategory: 'padding',
                evidenceArtifacts: [contract.reference],
              },
            ],
            score: 50,
            diffPercent: 12.5,
            changedFiles: [],
            reverted: false,
            timingsMs: { capture: 1 },
            failures: [],
          },
        ],
      }),
    );
    const findingsPage = await client.callTool({
      name: 'get_findings',
      arguments: { path: runPath, category: 'geometry', cursor: 1, limit: 1 },
    });
    expect(findingsPage.isError, JSON.stringify(findingsPage.content)).toBeFalsy();
    expect(findingsPage.structuredContent).toMatchObject({
      runId: 'paged-findings',
      passIndex: 0,
      visualMismatchPercent: 12.5,
      total: 2,
      cursor: 1,
      nextCursor: null,
      findings: [
        {
          id: 'padding',
          targetDomLocator: '[data-validation-id="card"]',
          expected: 24,
          actual: 16,
          delta: 8,
        },
      ],
    });

    const unapprovedRepair = await client.callTool({
      name: 'repair_component',
      arguments: {
        targetRoot: workflowRoot,
        designContractPath: workflowContractPath,
        artifactRoot: workflowArtifactRoot,
        url: 'http://127.0.0.1:4200',
        approved: true,
        allowWrite: ['src/approved.css'],
        proposedChanges: [
          {
            relativePath: 'src/not-approved.css',
            content: '.card {}',
            rationale: 'test exact approval',
          },
        ],
      },
    });
    expect(unapprovedRepair.isError).toBe(true);
    expect(unapprovedRepair.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('explicitly approved') }),
      ]),
    );

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

  it('bridges Studio authoring requests and responses through contained MCP tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSmartUiMcpServer();
    const client = new Client({ name: 'studio-bridge-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(
      () => client.close(),
      () => server.close(),
    );

    const studioWorkspace = await mkdtemp(join(resolve('tests'), '.mcp-studio-bridge-'));
    temporaryPaths.push(studioWorkspace);
    const runId = 'run-11111111-1111-4111-8111-111111111111';
    const now = Date.now();
    const requestsDir = join(studioWorkspace, 'agent-queue', 'requests', runId);
    await mkdir(requestsDir, { recursive: true });
    await writeFile(
      join(requestsDir, 'round-1.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        runId,
        round: 1,
        designName: 'design',
        viewport: { width: 320, height: 180 },
        mode: 'semantic',
        layout: 'responsive',
        theme: 'light',
        locale: 'en-US',
        fallbackStack: 'system-ui, sans-serif',
        unavailableFonts: [],
        readableText: ['Semantic title'],
        instructions: 'Keep the heading copy.',
        sanitizedSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"></svg>',
        svgTruncated: false,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString(),
      }),
    );

    const listed = await client.callTool({
      name: 'list_studio_authoring_requests',
      arguments: { studioWorkspace },
    });
    expect(listed.isError, JSON.stringify(listed.content)).toBeFalsy();
    expect(listed.structuredContent).toMatchObject({
      count: 1,
      requests: [
        {
          runId,
          round: 1,
          readableText: ['Semantic title'],
          instructions: 'Keep the heading copy.',
        },
      ],
    });
    const listedRequest = (
      listed.structuredContent as { requests: Array<{ canvasGuidance: string }> }
    ).requests[0];
    expect(listedRequest?.canvasGuidance).toContain('320x180');

    const unapproved = await client.callTool({
      name: 'submit_studio_authored_html',
      arguments: {
        studioWorkspace,
        runId,
        authoringAgent: 'contract-test-agent',
        files: [
          { path: 'index.html', content: '<!doctype html><html lang="en"></html>' },
          { path: 'styles.css', content: 'body{margin:0}' },
        ],
      },
    });
    expect(unapproved.isError).toBe(true);

    const submitted = await client.callTool({
      name: 'submit_studio_authored_html',
      arguments: {
        studioWorkspace,
        runId,
        approved: true,
        authoringAgent: 'contract-test-agent',
        files: [
          {
            path: 'index.html',
            content:
              '<!doctype html><html lang="en"><head><link rel="stylesheet" href="styles.css"></head><body><h1>Semantic title</h1></body></html>',
          },
          { path: 'styles.css', content: 'body{margin:0}' },
        ],
      },
    });
    expect(submitted.isError, JSON.stringify(submitted.content)).toBeFalsy();
    expect(submitted.structuredContent).toMatchObject({
      runId,
      round: 1,
      accepted: true,
      fileCount: 2,
    });
    const written = JSON.parse(
      await readFile(
        join(studioWorkspace, 'agent-queue', 'responses', runId, 'round-1.json'),
        'utf8',
      ),
    );
    expect(written).toMatchObject({ runId, round: 1, authoringAgent: 'contract-test-agent' });

    const missing = await client.callTool({
      name: 'submit_studio_authored_html',
      arguments: {
        studioWorkspace,
        runId: 'run-22222222-2222-4222-8222-222222222222',
        approved: true,
        authoringAgent: 'contract-test-agent',
        files: [
          { path: 'index.html', content: '<!doctype html><html lang="en"></html>' },
          { path: 'styles.css', content: 'body{margin:0}' },
        ],
      },
    });
    expect(missing.isError).toBe(true);
  });
});
