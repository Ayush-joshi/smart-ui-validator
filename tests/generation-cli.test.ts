import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { generationRecordSchema, upgradeGenerationRecord } from '../packages/core/src/index.js';

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

  it('returns an explicit migration message for --engine agent without creating artifacts', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generate-cli-agent-migration-'));
    const designPath = join(workspace, 'design.svg');
    await writeFile(designPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(
      executeFile(
        process.execPath,
        [cli, 'generate', '--workspace', workspace, '--design', designPath, '--engine', 'agent'],
        { cwd: resolve('.') },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/generation prepare/u),
    });
    expect(await readdir(workspace)).toEqual(['design.svg']);
  });

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
      stderr: expect.stringMatching(/generation prepare/u),
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
