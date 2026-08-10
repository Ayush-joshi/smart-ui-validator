import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const cli = resolve('apps/cli/dist/index.js');

describe('smart-ui generate CLI', () => {
  it('performs a compact JSON dry-run without writing deliverables', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-generate-cli-'));
    const svg = join(workspace, 'screen.svg');
    await writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#fff"/><text x="10" y="30" font-family="Arial" font-size="16">Safe SVG</text></svg>',
    );
    const { stdout } = await executeFile(
      process.execPath,
      [cli, 'generate', '--workspace', workspace, '--design', svg, '--dry-run', '--json'],
      { cwd: resolve('.') },
    );
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'dry-run', stoppedReason: 'dry-run', files: [] });
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
