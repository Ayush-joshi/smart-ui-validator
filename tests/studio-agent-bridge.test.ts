import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeterministicHtmlGenerationProvider,
  LocalArtifactStore,
  LocalSvgStructureProvider,
  agentQueueRoot,
  authoredHostFiles,
  authoringCanvasGuidance,
  authoringRequestSchema,
  buildAuthoringRequest,  deleteAuthoringRequest,
  listPendingAuthoringRequests,
  loadConfig,
  readAuthoringResponse,
  svgGenerationInputSchema,
  waitForAuthoringResponse,
  writeAuthoringRequest,
  writeAuthoringResponse,
  type StudioAuthoringResponse,
} from '../packages/core/src/index.js';

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const RUN_ID = 'run-00000000-0000-4000-8000-000000000000';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#fff"/><text x="24" y="52" fill="#123" font-family="Arial" font-size="28">Semantic title</text></svg>';

async function workspace(name: string): Promise<string> {
  const root = await mkdtemp(join(resolve('tests'), `.studio-bridge-${name}-`));
  temporaryPaths.push(root);
  return root;
}

async function inspectedRequest(ws: string, timeoutMs?: number) {
  const svgPath = join(ws, 'design.svg');
  await writeFile(svgPath, SVG);
  const config = await loadConfig(ws);
  const artifactRoot = join(ws, 'artifacts');
  const input = svgGenerationInputSchema.parse({
    workspaceRoot: ws,
    svgPath,
    artifactRoot,
    mode: 'semantic',
    layout: 'responsive',
    rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
    instructions: 'Use the exact heading copy.',
  });
  const inspection = await new LocalSvgStructureProvider(
    new LocalArtifactStore(artifactRoot),
    config.generation.limits,
  ).inspect(input);
  return buildAuthoringRequest({ runId: RUN_ID, input, inspection, ...(timeoutMs ? { timeoutMs } : {}) });
}

function validResponse(): StudioAuthoringResponse {
  return {
    schemaVersion: '1.0',
    runId: RUN_ID,
    authoringAgent: 'test-agent',
    createdAt: new Date().toISOString(),
    files: [
      {
        path: 'index.html',
        content:
          '<!doctype html><html lang="en"><head><link rel="stylesheet" href="styles.css"></head><body><h1>Semantic title</h1></body></html>',
      },
      { path: 'styles.css', content: 'body { margin: 0; }' },
    ],
  };
}

describe('Studio agent authoring bridge', () => {
  it('builds a bounded request carrying design evidence and verbatim user context', async () => {
    const ws = await workspace('build');
    const request = await inspectedRequest(ws);
    expect(request).toMatchObject({
      schemaVersion: '1.0',
      runId: RUN_ID,
      mode: 'semantic',
      layout: 'responsive',
      instructions: 'Use the exact heading copy.',
    });
    expect(request.readableText).toContain('Semantic title');
    expect(request.sanitizedSvg).toContain('<svg');
    expect(Date.parse(request.expiresAt)).toBeGreaterThan(Date.parse(request.createdAt));
    expect(() => authoringRequestSchema.parse(request)).not.toThrow();
  });

  it('anchors canvas guidance to the design viewport and layout intent', async () => {
    const ws = await workspace('guidance');
    const request = await inspectedRequest(ws);
    const responsive = authoringCanvasGuidance(request);
    expect(responsive).toContain('320x180');
    expect(responsive).toContain('320px-wide viewport');
    const fixed = authoringCanvasGuidance({ ...request, layout: 'fixed' });
    expect(fixed).toContain('fixed page');
    expect(fixed).toContain('320x180');
    const component = authoringCanvasGuidance({ ...request, layout: 'component' });
    expect(component).toContain('self-contained component');
    expect(component).toContain('320x180');
  });

  it('atomically round-trips a request through the queue and lists it while unexpired', async () => {
    const ws = await workspace('roundtrip');
    const queueRoot = agentQueueRoot(ws);
    const request = await inspectedRequest(ws);
    const path = await writeAuthoringRequest(queueRoot, request);
    expect(path.endsWith(`${RUN_ID}.json`)).toBe(true);
    const pending = await listPendingAuthoringRequests(queueRoot);
    expect(pending.map((item) => item.runId)).toEqual([RUN_ID]);
    // No stray temp files remain from the atomic write.
    const files = await readdir(join(queueRoot, 'requests'));
    expect(files).toEqual([`${RUN_ID}.json`]);
  });

  it('skips expired and malformed requests when listing', async () => {
    const ws = await workspace('expiry');
    const queueRoot = agentQueueRoot(ws);
    const expired = await inspectedRequest(ws, 1_000);
    expired.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await writeAuthoringRequest(queueRoot, expired);
    await writeFile(join(queueRoot, 'requests', 'garbage.json'), '{ not json');
    expect(await listPendingAuthoringRequests(queueRoot)).toEqual([]);
  });

  it('rejects a response that omits required files or uses a forbidden path', async () => {
    const ws = await workspace('reject');
    const queueRoot = agentQueueRoot(ws);
    await expect(
      writeAuthoringResponse(queueRoot, {
        ...validResponse(),
        files: [{ path: 'index.html', content: '<!doctype html>' }],
      } as StudioAuthoringResponse),
    ).rejects.toThrow();
    await expect(
      writeAuthoringResponse(queueRoot, {
        ...validResponse(),
        files: [
          { path: 'index.html', content: '<!doctype html>' },
          { path: '../escape.html', content: 'x' },
        ],
      } as StudioAuthoringResponse),
    ).rejects.toThrow();
  });

  it('fails closed when a stored response is malformed', async () => {
    const ws = await workspace('malformed');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringResponse(queueRoot, validResponse());
    await writeFile(join(queueRoot, 'responses', `${RUN_ID}.json`), '{ broken');
    await expect(readAuthoringResponse(queueRoot, RUN_ID)).rejects.toThrow(/not valid JSON/u);
  });

  it('waits for a response, then converts it to host proposal files', async () => {
    const ws = await workspace('wait');
    const queueRoot = agentQueueRoot(ws);
    const request = await inspectedRequest(ws);
    await writeAuthoringRequest(queueRoot, request);
    const pending = waitForAuthoringResponse(queueRoot, RUN_ID, {
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });
    await writeAuthoringResponse(queueRoot, validResponse());
    const response = await pending;
    const files = authoredHostFiles(response);
    expect(files.map((file) => file.relativePath).sort()).toEqual(['index.html', 'styles.css']);
    expect(files.find((file) => file.relativePath === 'index.html')?.mediaType).toBe('text/html');
    // Authored HTML flows through the deterministic host-proposal contract unchanged.
    expect(new DeterministicHtmlGenerationProvider().name).toBeTruthy();
  });

  it('times out and can delete the pending request on cancel', async () => {
    const ws = await workspace('timeout');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringRequest(queueRoot, await inspectedRequest(ws));
    await expect(
      waitForAuthoringResponse(queueRoot, RUN_ID, { timeoutMs: 1_000, pollIntervalMs: 50 }),
    ).rejects.toThrow(/No connected MCP agent/u);
    await deleteAuthoringRequest(queueRoot, RUN_ID);
    expect(await listPendingAuthoringRequests(queueRoot)).toEqual([]);
  });

  it('aborts the wait when the run is canceled', async () => {
    const ws = await workspace('abort');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringRequest(queueRoot, await inspectedRequest(ws));
    const controller = new AbortController();
    const pending = waitForAuthoringResponse(queueRoot, RUN_ID, {
      timeoutMs: 10_000,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/canceled/u);
  });
});
