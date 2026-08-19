import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  agentQueueRoot,
  generationRecordSchema,
  listPendingAuthoringRequests,
  upgradeGenerationRecord,
  writeAuthoringResponse,
} from '../packages/core/src/index.js';

const executeFile = promisify(execFile);
const cli = resolve('apps/cli/dist/index.js');

describe('smart-ui generate CLI', () => {
  it('performs a compact JSON dry-run without writing deliverables', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generate-cli-'));
    const svg = join(workspace, 'screen.svg');
    const contextPath = join(workspace, 'context.json');
    const presentationPath = join(workspace, 'presentation.json');
    await writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#fff"/><text x="10" y="30" font-family="Arial" font-size="16">Safe SVG</text></svg>',
    );
    await writeFile(
      contextPath,
      JSON.stringify({
        schemaVersion: '1.0',
        exactCopy: [],
        designTokens: [],
        componentSemantics: [],
        interactions: [],
        generalNotes: 'Keep this note typed and unchanged.',
      }),
    );
    await writeFile(
      presentationPath,
      JSON.stringify({
        schemaVersion: '1.0',
        primaryCanvas: {
          id: 'component',
          width: 360,
          height: 240,
          deviceScaleFactor: 2,
        },
        fit: 'contain',
        horizontalAlignment: 'center',
        verticalAlignment: 'center',
        viewports: [],
      }),
    );
    const { stdout } = await executeFile(
      process.execPath,
      [
        cli,
        'generate',
        '--workspace',
        workspace,
        '--design',
        svg,
        '--design-context',
        contextPath,
        '--presentation',
        presentationPath,
        '--engine',
        'agent',
        '--dry-run',
        '--json',
      ],
      { cwd: resolve('.') },
    );
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const result = JSON.parse(stdout) as Record<string, unknown> & { record: string };
    expect(result).toMatchObject({
      status: 'dry-run',
      stoppedReason: 'dry-run',
      engine: 'deterministic',
      files: [],
    });
    expect(await listPendingAuthoringRequests(agentQueueRoot(workspace))).toEqual([]);
    const record = JSON.parse(await readFile(result.record, 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: '2.0',
      input: {
        structuredContextHash: expect.stringMatching(/^sha256:/),
        presentationSpec: {
          primaryCanvas: { id: 'component', width: 360, height: 240, deviceScaleFactor: 2 },
          fit: 'contain',
        },
      },
    });
    const legacyInput = { ...(record['input'] as Record<string, unknown>) };
    delete legacyInput['presentationSpec'];
    delete legacyInput['structuredContextHash'];
    const legacy = generationRecordSchema.parse({
      ...record,
      schemaVersion: '1.0',
      input: legacyInput,
    });
    expect(upgradeGenerationRecord(legacy)).toMatchObject({
      schemaVersion: '2.0',
      input: { presentationSpec: { fit: 'intrinsic' } },
    });
  });

  it('accepts a PNG plus bounded JSX context and records both without exposing secrets', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generate-cli-png-'));
    const pngPath = join(workspace, 'checkout.png');
    const contextPath = join(workspace, 'Checkout.design');
    const structuredContextPath = join(workspace, 'structured-context.json');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(pngPath, png);
    await writeFile(
      contextPath,
      'export const Checkout = () => <main>Pay now</main>;\nauthorization: Bearer private-token',
    );
    await writeFile(
      structuredContextPath,
      JSON.stringify({
        schemaVersion: '1.0',
        exactCopy: [],
        designTokens: [],
        componentSemantics: [],
        interactions: [],
        generalNotes: 'Use the supplied component structure.',
      }),
    );
    let stdout = '';
    try {
      stdout = (
        await executeFile(
          process.execPath,
          [
            cli,
            'generate',
            '--workspace',
            workspace,
            '--design',
            pngPath,
            '--design-context',
            contextPath,
            '--structured-context',
            structuredContextPath,
            '--dry-run',
            '--json',
          ],
          { cwd: resolve('.') },
        )
      ).stdout;
    } catch (error) {
      const warningResult = error as { code: number; stdout: string };
      expect(warningResult.code).toBe(3);
      stdout = warningResult.stdout;
    }
    const result = JSON.parse(stdout) as {
      record: string;
      designReference: { mediaType: string; hash: string; artifact: string };
      designContext: { hash: string; contentRedacted: boolean; artifact: string };
    };
    expect(result.designReference).toMatchObject({
      mediaType: 'image/png',
      hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(await readFile(result.designReference.artifact)).toEqual(png);
    expect(result.designContext).toMatchObject({
      hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      contentRedacted: true,
    });
    const retainedContext = await readFile(result.designContext.artifact, 'utf8');
    expect(retainedContext).toContain('export const Checkout');
    expect(retainedContext).toContain('[REDACTED]');
    expect(retainedContext).not.toContain('private-token');
    const record = JSON.parse(await readFile(result.record, 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: '2.0',
      originalInputHash: result.designReference.hash,
      designReference: { mediaType: 'image/png', byteLength: png.byteLength },
      designContext: {
        mediaType: 'text/plain',
        byteLength: new TextEncoder().encode(retainedContext).byteLength,
      },
      input: {
        designReferenceOriginalHash: result.designReference.hash,
        designReferenceMediaType: 'image/png',
        designContextOriginalHash: result.designContext.hash,
        designContextContentRedacted: true,
        structuredContextHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect((await readdir(workspace)).some((name) => name.startsWith('.smart-ui-png-input-'))).toBe(
      false,
    );
  });

  it('queues PNG and JSX evidence for an MCP agent, consumes its response, and verifies output', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generate-cli-agent-'));
    const pngPath = join(workspace, 'agent design.png');
    const contextPath = join(workspace, 'AgentDesign.jsx');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(pngPath, png);
    await writeFile(contextPath, 'export const AgentDesign = () => <main>Agent copy</main>;');
    const child = spawn(
      process.execPath,
      [
        cli,
        'generate',
        '--workspace',
        workspace,
        '--design',
        pngPath,
        '--design-context',
        contextPath,
        '--engine',
        'agent',
        '--agent-timeout',
        '60000',
        '--timeout',
        '60000',
        '--json',
      ],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const completion = new Promise<number>((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code) => accept(code ?? -1));
    });
    try {
      const queueRoot = agentQueueRoot(workspace);
      let pending: Awaited<ReturnType<typeof listPendingAuthoringRequests>>[number] | undefined;
      for (let attempt = 0; attempt < 400 && !pending; attempt += 1) {
        pending = (await listPendingAuthoringRequests(queueRoot))[0];
        if (!pending) await new Promise((accept) => setTimeout(accept, 25));
      }
      expect(pending, stderr).toBeTruthy();
      expect(pending).toMatchObject({
        round: 1,
        designReference: {
          filename: 'agent design.png',
          mediaType: 'image/png',
          byteLength: png.byteLength,
          originalHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        designContext: {
          filename: 'AgentDesign.jsx',
          mediaType: 'text/javascript',
          content: expect.stringContaining('Agent copy'),
          provenance: 'cli:user-supplied',
        },
        visualEvidence: [
          {
            kind: 'design-render',
            mediaType: 'image/png',
            byteLength: png.byteLength,
          },
        ],
      });
      const visualReference = pending!.visualEvidence?.[0];
      expect(visualReference?.workspaceRelativePath).toMatch(
        /^\.smart-ui-cli-agent-evidence-[^/]+\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/u,
      );
      expect(visualReference?.hash).toBe(pending!.designReference?.originalHash);
      expect(await readFile(join(workspace, visualReference!.workspaceRelativePath))).toEqual(png);
      await writeAuthoringResponse(queueRoot, {
        schemaVersion: '1.0',
        runId: pending!.runId,
        round: 1,
        authoringAgent: 'cli-agent-test',
        createdAt: new Date().toISOString(),
        files: [
          {
            path: 'index.html',
            content:
              '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main>Agent copy</main></body></html>',
          },
          {
            path: 'styles.css',
            content:
              'html,body{margin:0;width:1px;height:1px;overflow:hidden}main{width:1px;height:1px}',
          },
        ],
      });
      const exitCode = await completion;
      expect([0, 3]).toContain(exitCode);
      expect(stderr).toContain('list_studio_authoring_requests');
      const result = JSON.parse(stdout) as {
        status: string;
        engine: string;
        authoringHost: string;
        record: string;
      };
      expect(result).toMatchObject({
        engine: 'agent',
        authoringHost: 'cli-agent:cli-agent-test',
      });
      expect(result.status).not.toBe('failed');
      const record = JSON.parse(await readFile(result.record, 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({
        originalInputHash: pending!.designReference?.originalHash,
        provenance: {
          tool: 'smart-ui',
          hostProposal: true,
          hostProposalAccepted: true,
          host: 'cli-agent:cli-agent-test',
        },
        designReference: { mediaType: 'image/png' },
        designContext: expect.objectContaining({ byteLength: expect.any(Number) }),
      });
      expect(await listPendingAuthoringRequests(queueRoot)).toEqual([]);
      expect(
        (await readdir(workspace)).some(
          (name) =>
            name.startsWith('.smart-ui-png-input-') ||
            name.startsWith('.smart-ui-cli-agent-evidence-'),
        ),
      ).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGINT');
        await completion.catch(() => undefined);
      }
    }
  }, 180_000);

  it('fails closed and removes queued evidence when no CLI authoring agent responds', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generate-cli-agent-timeout-'));
    const pngPath = join(workspace, 'timeout.png');
    await writeFile(
      pngPath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    await expect(
      executeFile(
        process.execPath,
        [
          cli,
          'generate',
          '--workspace',
          workspace,
          '--design',
          pngPath,
          '--engine',
          'agent',
          '--agent-timeout',
          '1000',
          '--json',
        ],
        { cwd: resolve('.') },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /(?:authoring request expired|No connected MCP agent authored this design in time)/u,
      ),
    });
    expect(await listPendingAuthoringRequests(agentQueueRoot(workspace))).toEqual([]);
    expect(
      (await readdir(workspace)).some(
        (name) =>
          name.startsWith('.smart-ui-png-input-') ||
          name.startsWith('.smart-ui-cli-agent-evidence-'),
      ),
    ).toBe(false);
  }, 30_000);

  it('rejects malformed PNG and binary source-context inputs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generate-cli-invalid-input-'));
    const malformedPng = join(workspace, 'broken.png');
    await writeFile(malformedPng, 'not a png');
    await expect(
      executeFile(
        process.execPath,
        [cli, 'generate', '--workspace', workspace, '--design', malformedPng, '--dry-run'],
        { cwd: resolve('.') },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/PNG signature/u) });

    const svg = join(workspace, 'safe.svg');
    const binaryContext = join(workspace, 'context.bin');
    await writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
    );
    await writeFile(binaryContext, new Uint8Array([65, 0, 66]));
    await expect(
      executeFile(
        process.execPath,
        [
          cli,
          'generate',
          '--workspace',
          workspace,
          '--design',
          svg,
          '--design-context',
          binaryContext,
          '--dry-run',
        ],
        { cwd: resolve('.') },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/not binary/u) });

    await expect(
      executeFile(
        process.execPath,
        [
          cli,
          'generate',
          '--workspace',
          workspace,
          '--design',
          svg,
          '--engine',
          'agent',
          '--max-passes',
          '0',
        ],
        { cwd: resolve('.') },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/requires --max-passes 1/u),
    });
  });

  it('uses a generation-local unsafe SVG exit code and persists bounded rejection evidence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generate-cli-unsafe-'));
    const svg = join(workspace, 'unsafe.svg');
    await writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    let stdout = '';
    let code: number | undefined;
    try {
      await executeFile(
        process.execPath,
        [cli, 'generate', '--workspace', workspace, '--design', svg, '--dry-run', '--json'],
        { cwd: resolve('.') },
      );
    } catch (error) {
      const failure = error as { stdout: string; code: number };
      stdout = failure.stdout;
      code = failure.code;
    }
    expect(code).toBe(6);
    const result = JSON.parse(stdout) as { record: string };
    expect(result).toMatchObject({
      status: 'failed',
      stoppedReason: 'unsafe-svg',
      sanitization: { accepted: false },
      files: [],
    });
    const record = JSON.parse(await readFile(result.record, 'utf8')) as {
      originalInputHash: string;
      sanitizedSource?: unknown;
    };
    expect(record.originalInputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record).not.toHaveProperty('sanitizedSource');
  });
});
