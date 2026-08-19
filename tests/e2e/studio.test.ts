import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { generationRecordSchema } from '../../packages/core/src/index.js';
import {
  initializeStudioWorkspace,
  startStudioServer,
  type StudioServer,
} from '../../apps/studio/src/server.js';

const executeFile = promisify(execFile);
const servers: StudioServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe('Studio real-browser workflow', () => {
  it('uploads, generates, isolates preview, downloads evidence, matches CLI manifests, cancels, and shuts down', async () => {
    const context = await fixture();
    const uiBrowser = await chromium.launch({ headless: true });
    let uploaded: RunSummary | undefined;
    try {
      const page = await uiBrowser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(context.server.url);
      expect(await page.locator('h1').textContent()).toBe('Smart UI Studio');
      await page.locator('button.work-type-card').filter({ hasText: 'Generate UI' }).click();
      expect(await page.locator('nav[aria-label="Studio workflow steps"] button').count()).toBe(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page
        .locator('input[type="file"][accept*="image/svg+xml"]')
        .setInputFiles(resolve('fixtures/svg-generation/basic.svg'));
      await page.locator('#preferences-title').waitFor();
      expect(await page.locator('.summary-strip').textContent()).toContain('Accepted');
      await page.locator('input[name="engine"][value="deterministic"]').check();
      await page.locator('input[name="mode"][value="exact"]').check();
      await page.getByRole('button', { name: 'Continue to handoff' }).click();
      await page.getByRole('button', { name: 'Run deterministic generator' }).click();
      await page.locator('#generate-title').waitFor();
      await page.locator('#review-title').waitFor({ timeout: 30_000 });
      expect(await page.locator('.metrics').textContent()).toContain('Source visual similarity');
      await page.locator('.file-row button').first().click();
      await page.locator('pre[aria-label^="Source for"]').waitFor();

      const runs = await apiJson<RunSummary[]>(await context.request('/api/runs'));
      uploaded = runs.find((run) => run.phase === 'completed');
      expect(uploaded?.inspection?.sanitization.accepted).toBe(true);

      await page.getByRole('button', { name: 'Reset workflow' }).click();
      await page.locator('button.work-type-card').filter({ hasText: 'Generate UI' }).click();
      await page
        .locator('input[type="file"][accept*="image/svg+xml"]')
        .setInputFiles(resolve('fixtures/svg-generation/basic.svg'));
      await page.locator('#preferences-title').waitFor();
      await page.locator('input[name="engine"][value="deterministic"]').check();
      await page.getByRole('button', { name: 'Continue to handoff' }).click();
      await page.getByRole('button', { name: 'Run deterministic generator' }).click();
      await page.getByRole('button', { name: 'Cancel generation' }).click();
      await page.getByRole('heading', { name: 'Generation canceled' }).waitFor({ timeout: 15_000 });

      await page.getByRole('button', { name: 'Reset workflow' }).click();
      await page.locator('button.work-type-card').filter({ hasText: 'Generate UI' }).click();
      await page
        .locator('input[type="file"][accept*="image/svg+xml"]')
        .setInputFiles(resolve('fixtures/svg-generation/unsafe-script.svg'));
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').textContent()).toContain('not allowed');
    } finally {
      await uiBrowser.close();
    }
    if (!uploaded) throw new Error('Studio UI did not persist its completed run.');
    const completed = await poll(context, uploaded.runId);
    expect(completed.phase, JSON.stringify(completed, null, 2)).toBe('completed');
    expect(completed.generation).toMatchObject({
      status: expect.stringMatching(/succeeded|completed-with-warnings/u),
      requestedMode: 'exact',
      finalMode: 'exact',
      visualMismatchPercent: expect.any(Number),
    });
    expect(completed.generation!.viewports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification: 'source-fidelity' }),
        expect.objectContaining({ classification: 'responsive-robustness' }),
      ]),
    );

    const previewUrl = completed.generation!.previewUrl!;
    expect(new URL(previewUrl).origin).not.toBe(context.origin);
    const preview = await fetch(previewUrl);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(await fetch(`${new URL(previewUrl).origin}/api/health`)).toMatchObject({ status: 404 });

    const source = await apiJson<{ relativePath: string; source: string }>(
      await context.request(`/api/runs/${uploaded.runId}/files/0`),
    );
    expect(source.relativePath).toBe('index.html');
    expect(source.source).toContain('<!doctype html>');

    for (const endpoint of [
      completed.generation!.downloads.archive!,
      completed.generation!.downloads.report!,
      completed.generation!.evidence!.screenshot,
      completed.generation!.evidence!.diff,
      completed.generation!.evidence!.overlay,
    ]) {
      const response = await context.browserGet(endpoint);
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    const report = await context.browserGet(completed.generation!.downloads.report!);
    const reportText = await report.text();
    expect(reportText).not.toContain(context.workspace);

    const pointer = JSON.parse(
      await readFile(join(context.workspace, 'runs', uploaded.runId, 'studio-run.json'), 'utf8'),
    ) as { selectedRound: number; recordArtifactPath: string };
    const studioRecord = generationRecordSchema.parse(
      JSON.parse(
        await readFile(
          join(
            context.workspace,
            'runs',
            uploaded.runId,
            'artifacts',
            `round-${pointer.selectedRound}`,
            pointer.recordArtifactPath,
          ),
          'utf8',
        ),
      ),
    );
    expect(studioRecord.provenance.tool).toBe('smart-ui-studio');

    const directArtifacts = join(context.workspace, 'direct-cli-artifacts');
    const cli = await executeFile(
      process.execPath,
      [
        resolve('apps/cli/dist/index.js'),
        'generate',
        '--workspace',
        context.workspace,
        '--design',
        join(context.workspace, 'runs', uploaded.runId, 'input', 'upload.svg'),
        '--artifacts',
        directArtifacts,
        '--mode',
        'exact',
        '--layout',
        'responsive',
        '--json',
      ],
      { cwd: resolve('.'), maxBuffer: 2_000_000 },
    );
    const cliSummary = JSON.parse(cli.stdout) as { record: string };
    const cliRecord = generationRecordSchema.parse(
      JSON.parse(await readFile(cliSummary.record, 'utf8')),
    );
    expect(cliRecord.manifestHash).toBe(studioRecord.manifestHash);
    expect(cliRecord.generatedFiles.map((file) => file.hash)).toEqual(
      studioRecord.generatedFiles.map((file) => file.hash),
    );

    const finalRuns = await apiJson<RunSummary[]>(await context.request('/api/runs'));
    expect(finalRuns.some((run) => run.phase === 'canceled')).toBe(true);

    await context.server.close();
    servers.splice(servers.indexOf(context.server), 1);
    await expect(fetch(previewUrl)).rejects.toThrow();
  }, 90_000);
});

interface RunSummary {
  runId: string;
  phase: 'inspected' | 'generating' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  inspection?: { sanitization: { accepted: boolean } };
  generation: null | {
    status: string;
    requestedMode: string;
    finalMode?: string;
    visualMismatchPercent: number | null;
    previewUrl: string | null;
    viewports: Array<{ classification: string }>;
    downloads: { archive: string | null; report: string | null };
    evidence: { screenshot: string; diff: string; overlay: string } | null;
  };
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-studio-e2e-'));
  await initializeStudioWorkspace(workspace);
  const staticRoot = resolve('apps/studio/dist/public');
  const server = await startStudioServer({ workspaceRoot: workspace, staticRoot });
  servers.push(server);
  const origin = server.url.slice(0, -1);
  const root = await fetch(server.url);
  const cookie = root.headers.get('set-cookie')!.split(';')[0]!;
  const session = await apiJson<{ csrfToken: string }>(
    await fetch(`${server.url}api/session`, { headers: { Cookie: cookie } }),
  );
  return {
    workspace,
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
    browserGet(path: string) {
      return fetch(`${origin}${path}`, { headers: { Cookie: cookie } });
    },
  };
}

async function poll(context: Awaited<ReturnType<typeof fixture>>, runId: string) {
  for (let index = 0; index < 500; index++) {
    const run = await apiJson<RunSummary>(await context.request(`/api/runs/${runId}`));
    if (run.phase !== 'generating') return run;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error('Studio generation did not reach a terminal state.');
}

async function apiJson<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(value.message ?? `Request failed: ${response.status}`);
  return value;
}
