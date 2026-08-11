import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentQueueRoot,
  listPendingAuthoringRequests,
  writeAuthoringResponse,
} from '../packages/core/src/index.js';
import {
  initializeStudioWorkspace,
  startStudioServer,
  type StudioServer,
} from '../apps/studio/src/server.js';

const servers: StudioServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe('local Studio server security and lifecycle', () => {
  it('refuses broad or non-dedicated roots and initializes only an empty workspace', async () => {
    await expect(initializeStudioWorkspace('/')).rejects.toThrow(/refuses filesystem roots/u);
    const nonempty = await mkdtemp(join(tmpdir(), 'smart-ui-studio-nonempty-'));
    await writeFile(join(nonempty, 'existing.txt'), 'owned');
    await expect(initializeStudioWorkspace(nonempty)).rejects.toThrow(/new empty dedicated/u);

    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-studio-init-'));
    const initialized = await initializeStudioWorkspace(workspace);
    expect(initialized).toMatchObject({ workspaceRoot: workspace, initialized: true });
    await expect(initializeStudioWorkspace(workspace)).resolves.toMatchObject({
      initialized: false,
    });
  });

  it('enforces host, session capability, origin, CSRF, content type, and upload budgets', async () => {
    const context = await studioFixture(300);
    const rootResponse = await fetch(context.server.url);
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get('access-control-allow-origin')).toBeNull();
    expect(rootResponse.headers.get('content-security-policy')).toContain("default-src 'self'");
    const cookie = rootResponse.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^smart_ui_studio=/u);

    await expect(fetch(`${context.server.url}api/health`)).resolves.toMatchObject({ status: 403 });
    const session = await json<{ csrfToken: string }>(
      await fetch(`${context.server.url}api/session`, { headers: { Cookie: cookie! } }),
    );
    expect(session.csrfToken).toHaveLength(43);

    const wrongOrigin = await fetch(`${context.server.url}api/runs`, {
      method: 'POST',
      headers: {
        Cookie: cookie!,
        Origin: 'http://malicious.invalid',
        'X-Smart-UI-CSRF': session.csrfToken,
        'Content-Type': 'image/svg+xml',
      },
      body: cleanSvg,
    });
    expect(wrongOrigin.status).toBe(403);

    const missingCsrf = await fetch(`${context.server.url}api/runs`, {
      method: 'POST',
      headers: {
        Cookie: cookie!,
        Origin: context.origin,
        'Content-Type': 'image/svg+xml',
      },
      body: cleanSvg,
    });
    expect(missingCsrf.status).toBe(403);

    const wrongType = await context.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: cleanSvg,
    });
    expect(wrongType.status).toBe(400);

    const oversized = await context.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'image/svg+xml' },
      body: `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(400)}</svg>`,
    });
    expect(oversized.status).toBe(400);
    expect(await readdir(join(context.workspace, 'runs'))).toEqual([]);

    const host = new URL(context.server.url).host;
    expect(await statusWithHost(context.server.url, `localhost:${host.split(':')[1]}`)).toBe(421);
  });

  it('fails malicious SVG closed, supports concurrent isolated runs, recovery, and verified deletion', async () => {
    const context = await studioFixture(4_000);
    const malicious = await context.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'image/svg+xml', 'X-Smart-UI-Filename': 'unsafe.svg' },
      body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    expect(malicious.status).toBeGreaterThanOrEqual(400);
    expect(await readdir(join(context.workspace, 'runs'))).toEqual([]);

    const [firstResponse, secondResponse] = await Promise.all([
      context.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'image/svg+xml', 'X-Smart-UI-Filename': 'first.svg' },
        body: cleanSvg,
      }),
      context.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'image/svg+xml', 'X-Smart-UI-Filename': 'second.svg' },
        body: cleanSvg.replace('#4f7cff', '#44cc88'),
      }),
    ]);
    const first = await json<{
      runId: string;
      inspection: { sanitization: { accepted: boolean } };
    }>(firstResponse);
    const second = await json<{ runId: string }>(secondResponse);
    expect(first.inspection.sanitization.accepted).toBe(true);
    expect(first.runId).not.toBe(second.runId);
    for (const runId of [first.runId, second.runId]) {
      expect(
        (
          await stat(
            join(context.workspace, 'runs', runId, 'inspection-artifacts', 'manifest.json'),
          )
        ).isFile(),
      ).toBe(true);
    }

    await context.server.close();
    servers.splice(servers.indexOf(context.server), 1);
    const recovered = await connect(context.workspace, context.staticRoot);
    const listed = await json<Array<{ runId: string }>>(await recovered.request('/api/runs'));
    expect(listed.map((item) => item.runId).sort()).toEqual([first.runId, second.runId].sort());

    const deleted = await json<{ deleted: boolean; verified: boolean }>(
      await recovered.request(`/api/runs/${first.runId}`, { method: 'DELETE' }),
    );
    expect(deleted).toEqual({ runId: first.runId, deleted: true, verified: true });
    await expect(stat(join(context.workspace, 'runs', first.runId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await readdir(join(context.workspace, 'runs'))).every((name) => name === second.runId),
    ).toBe(true);
  });

  it('expires only old completed runs and reports packaged health without leaking local paths', async () => {
    const context = await studioFixture(4_000);
    const created = await json<{ runId: string }>(
      await context.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'image/svg+xml' },
        body: cleanSvg,
      }),
    );
    const pointerPath = join(context.workspace, 'runs', created.runId, 'studio-run.json');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as Record<string, unknown>;
    pointer['phase'] = 'completed';
    pointer['updatedAt'] = new Date(0).toISOString();
    await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    await context.server.close();
    servers.splice(servers.indexOf(context.server), 1);

    const recovered = await connect(context.workspace, context.staticRoot, 1_000);
    expect(await json(await recovered.request('/api/runs'))).toEqual([]);
    expect((await recovered.server.health()).status).toBe('ready');
    const healthText = JSON.stringify(await recovered.server.health());
    expect(healthText).not.toContain(context.workspace);
  });

  it('reports the contained agent workspace and mcp transport in the session', async () => {
    const context = await studioFixture(4_000);
    const session = await json<{
      agent: { configured: boolean; transport: string; workspace: string };
    }>(await context.request('/api/session'));
    expect(session.agent).toMatchObject({ configured: true, transport: 'mcp' });
    expect(session.agent.workspace).toBe(context.workspace);
  });

  it('waits for the connected MCP agent, writes a bounded request, and deletes it on cancel', async () => {
    const context = await studioFixture(4_000);
    const run = await json<{ runId: string }>(
      await context.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'image/svg+xml', 'X-Smart-UI-Filename': 'agent.svg' },
        body: cleanSvg,
      }),
    );
    await context.request(`/api/runs/${run.runId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'agent', mode: 'semantic', layout: 'responsive' }),
    });
    await waitForPhase(context, run.runId, 'awaiting-agent');
    const requestPath = join(
      context.workspace,
      'agent-queue',
      'requests',
      run.runId,
      'round-1.json',
    );
    const request = JSON.parse(await readFile(requestPath, 'utf8')) as {
      runId: string;
      round: number;
      visualEvidence?: Array<{ kind: string; workspaceRelativePath: string; byteLength: number }>;
    };
    expect(request).toMatchObject({ runId: run.runId, round: 1 });
    const designRender = request.visualEvidence?.find((item) => item.kind === 'design-render');
    expect(designRender, 'the agent receives a rendered design image').toBeTruthy();
    await expect(
      stat(join(context.workspace, designRender!.workspaceRelativePath)),
    ).resolves.toMatchObject({ size: designRender!.byteLength });

    await context.request(`/api/runs/${run.runId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await waitForPhase(context, run.runId, 'canceled');
    await expect(stat(requestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when no connected agent authors the design in time', async () => {
    const context = await studioFixture(4_000, 1_000);
    const run = await json<{ runId: string }>(
      await context.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'image/svg+xml', 'X-Smart-UI-Filename': 'agent.svg' },
        body: cleanSvg,
      }),
    );
    await context.request(`/api/runs/${run.runId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'agent', mode: 'semantic', layout: 'responsive' }),
    });
    const failed = await waitForPhase(context, run.runId, 'failed');
    expect(failed.error?.message).toMatch(/expired before the agent responded/u);
  });

  it('queues, measures, and isolates a second authoring round after the first is rejected', async () => {
    const context = await studioFixture(4_000, 60_000);
    const run = await json<{ runId: string }>(
      await context.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'image/svg+xml', 'X-Smart-UI-Filename': 'improve.svg' },
        body: cleanSvg,
      }),
    );
    const queueRoot = agentQueueRoot(context.workspace);
    const structuredDesignContext = {
      schemaVersion: '1.0' as const,
      exactCopy: [
        {
          id: 'card-copy',
          label: 'Card label',
          text: 'Hello',
          sourceNodeIds: ['text'],
          provenance: 'Studio user input',
        },
      ],
      designTokens: [],
      componentSemantics: [],
      interactions: [],
      generalNotes: 'Keep the card copy exact.',
    };
    const presentationSpec = {
      schemaVersion: '1.0' as const,
      primaryCanvas: {
        id: 'preview',
        width: 240,
        height: 160,
        deviceScaleFactor: 1,
      },
      fit: 'contain' as const,
      horizontalAlignment: 'center' as const,
      verticalAlignment: 'center' as const,
      viewports: [],
    };
    const answerRound = async (round: number, background: string) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const pending = await listPendingAuthoringRequests(queueRoot);
        const request = pending.find((item) => item.round === round);
        if (request) {
          expect(request.structuredDesignContext).toEqual(structuredDesignContext);
          expect(request.presentationSpec).toEqual(presentationSpec);
          expect(request.structuredContextHash).toMatch(/^sha256:/u);
          await writeAuthoringResponse(queueRoot, {
            schemaVersion: '1.0',
            runId: run.runId,
            round,
            authoringAgent: 'improve-test-agent',
            createdAt: new Date().toISOString(),
            files: [
              {
                path: 'index.html',
                content:
                  '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head><body><div class="card">Hello</div></body></html>',
              },
              {
                path: 'styles.css',
                content: `html,body{margin:0;padding:0;width:120px;height:80px}.card{width:120px;height:80px;background:${background};color:#fff;font-size:18px}`,
              },
            ],
          });
          return;
        }
        await new Promise((accept) => setTimeout(accept, 50));
      }
      throw new Error(`Authoring round ${round} was never queued.`);
    };

    await context.request(`/api/runs/${run.runId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'agent',
        mode: 'semantic',
        layout: 'responsive',
        improve: true,
        structuredDesignContext,
        presentationSpec,
      }),
    });
    await answerRound(1, '#4f7cff');
    await waitForPhase(context, run.runId, 'awaiting-decision');

    const improve = await context.request(`/api/runs/${run.runId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'improve', feedback: 'Make the card green.' }),
    });
    expect(improve.status).toBe(202);
    await answerRound(2, '#44cc88');
    const reviewed = await waitForPhase(context, run.runId, 'awaiting-decision');
    expect(reviewed.error).toBeUndefined();
    expect(reviewed.rounds?.map((item) => item.round)).toEqual([1, 2]);
    // Each round owns a separate generation artifact root, as the orchestrator requires.
    for (const round of [1, 2]) {
      expect(
        (
          await stat(join(context.workspace, 'runs', run.runId, 'artifacts', `round-${round}`))
        ).isDirectory(),
      ).toBe(true);
    }
  }, 180_000);
});

interface StudioRunSummary {
  runId: string;
  phase: string;
  rounds?: Array<{ round: number }>;
  error?: { message: string };
}

async function waitForPhase(
  context: { request(path: string, init?: RequestInit): Promise<Response> },
  runId: string,
  phase: string,
): Promise<StudioRunSummary> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await json<StudioRunSummary>(await context.request(`/api/runs/${runId}`));
    if (run.phase === phase) return run;
    if (['completed', 'failed', 'canceled'].includes(run.phase) && run.phase !== phase) {
      throw new Error(`Run reached ${run.phase} before ${phase}: ${JSON.stringify(run.error)}`);
    }
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error(`Run ${runId} never reached ${phase}.`);
}

const cleanSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#4f7cff"/><text x="12" y="42" fill="white" font-size="18">Hello</text></svg>';

async function studioFixture(maxSvgBytes: number, agentTimeoutMs?: number) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'smart-ui-studio-workspace-')));
  await initializeStudioWorkspace(workspace);
  await writeFile(
    join(workspace, 'smart-ui.config.json'),
    `${JSON.stringify({ generation: { limits: { maxSvgBytes } } }, null, 2)}\n`,
  );
  const staticRoot = await mkdtemp(join(tmpdir(), 'smart-ui-studio-assets-'));
  await writeFile(
    join(staticRoot, 'index.html'),
    '<!doctype html><div id="root"></div><script src="/assets/app.js"></script>',
  );
  await writeFile(join(staticRoot, 'app-placeholder'), 'unused');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(staticRoot, 'assets')));
  await writeFile(join(staticRoot, 'assets', 'app.js'), 'document.body.dataset.ready="true";');
  return connect(workspace, staticRoot, undefined, agentTimeoutMs);
}

async function connect(
  workspace: string,
  staticRoot: string,
  retentionMs?: number,
  agentTimeoutMs?: number,
) {
  const server = await startStudioServer({
    workspaceRoot: workspace,
    staticRoot,
    ...(retentionMs ? { retentionMs } : {}),
    ...(agentTimeoutMs ? { agentTimeoutMs } : {}),
  });
  servers.push(server);
  const origin = server.url.slice(0, -1);
  const root = await fetch(server.url);
  const cookie = root.headers.get('set-cookie')!.split(';')[0]!;
  const session = await json<{ csrfToken: string }>(
    await fetch(`${server.url}api/session`, { headers: { Cookie: cookie } }),
  );
  return {
    workspace,
    staticRoot,
    server,
    origin,
    request(path: string, init: RequestInit = {}) {
      return fetch(`${origin}${path}`, {
        ...init,
        headers: {
          Cookie: cookie,
          Origin: origin,
          'X-Smart-UI-CSRF': session.csrfToken,
          ...init.headers,
        },
      });
    },
  };
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise<number>((resolveStatus, rejectStatus) => {
    const request = httpRequest(url, { headers: { Host: host } }, (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    request.once('error', rejectStatus);
    request.end();
  });
}
