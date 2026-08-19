import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const cli = resolve('apps/cli/dist/index.js');

describe('handoff CLI contracts', () => {
  it('previews generation without artifacts and then creates a persistent task', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'smart-ui-handoff-cli-generation-'));
    const designPath = join(workspace, 'design.svg');
    await writeFile(
      designPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text x="8" y="24">CLI</text></svg>',
    );
    const dryRun = JSON.parse(
      (
        await executeFile(
          process.execPath,
          [
            cli,
            'generation',
            'prepare',
            '--workspace',
            workspace,
            '--design',
            designPath,
            '--dry-run',
            '--json',
          ],
          { cwd: resolve('.') },
        )
      ).stdout,
    ) as { dryRun: boolean };
    expect(dryRun.dryRun).toBe(true);
    expect(await readdir(workspace)).toEqual(['design.svg']);

    const prepared = JSON.parse(
      (
        await executeFile(
          process.execPath,
          [
            cli,
            'generation',
            'prepare',
            '--workspace',
            workspace,
            '--design',
            designPath,
            '--json',
          ],
          { cwd: resolve('.') },
        )
      ).stdout,
    ) as { taskFile: string; status: string; proposalDirectory: string };
    expect(prepared.status).toBe('awaiting-author');
    expect(JSON.parse(await readFile(prepared.taskFile, 'utf8'))).toMatchObject({
      taskType: 'generation',
    });
    expect(await readdir(prepared.proposalDirectory)).toEqual([]);
  });

  it('prepares validate-UI with repeated exact writable files', async () => {
    const target = await mkdtemp(join(tmpdir(), 'smart-ui-handoff-cli-implementation-'));
    await mkdir(join(target, 'src'));
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({ dependencies: { react: '19.1.1' }, devDependencies: { vite: '8.2.0' } }),
    );
    await writeFile(join(target, 'src', 'Page.tsx'), 'export const Page = () => <main />;\n');
    await writeFile(
      join(target, 'design.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"/>',
    );
    const prepared = JSON.parse(
      (
        await executeFile(
          process.execPath,
          [
            cli,
            'validate-ui',
            'prepare',
            '--target',
            target,
            '--design',
            join(target, 'design.svg'),
            '--route',
            'http://127.0.0.1:4173/page',
            '--allow-write',
            'src/Page.tsx',
            '--allow-write',
            'src/Page.css',
            '--json',
          ],
          { cwd: resolve('.') },
        )
      ).stdout,
    ) as { taskFile: string; writableFiles: string[]; framework: string };
    expect(prepared.writableFiles).toEqual(['src/Page.tsx', 'src/Page.css']);
    expect(prepared.framework).toBe('react');
    expect(JSON.parse(await readFile(prepared.taskFile, 'utf8'))).toMatchObject({
      taskType: 'validate-ui',
      baselines: [
        expect.objectContaining({ relativePath: 'src/Page.tsx', existed: true }),
        { relativePath: 'src/Page.css', existed: false },
      ],
    });
  });
});
