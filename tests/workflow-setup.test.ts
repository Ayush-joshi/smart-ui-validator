import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('one-command workflow setup', () => {
  it('creates target-contained, idempotent evidence and agent instructions', async () => {
    const root = await mkdtemp(join(resolve('tests'), '.workflow-setup-'));
    temporaryPaths.push(root);
    const targetRoot = join(root, 'target');
    const designPath = join(root, 'login.svg');
    await mkdir(targetRoot);
    await writeFile(join(targetRoot, 'package.json'), JSON.stringify({ name: 'target' }));
    await writeFile(
      designPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>',
    );
    const args = [
      resolve('scripts/setup-workflow.mjs'),
      '--target',
      targetRoot,
      '--design',
      designPath,
      '--url',
      'http://127.0.0.1:4200/',
      '--component',
      'LoginComponent',
      '--host',
      'codex',
    ];

    const first = JSON.parse((await execute(process.execPath, args)).stdout) as {
      manifestPath: string;
      instructionsPath: string;
      hostConfigPath: string;
    };
    const second = JSON.parse((await execute(process.execPath, args)).stdout) as {
      manifestPath: string;
    };
    expect(second.manifestPath).toBe(first.manifestPath);
    expect(JSON.parse(await readFile(first.manifestPath, 'utf8'))).toMatchObject({
      schemaVersion: '1.0',
      targetRoot,
      route: 'http://127.0.0.1:4200/',
      design: { imagePath: join(targetRoot, '.smart-ui', 'design', 'login.svg') },
      artifactRoot: join(targetRoot, '.smart-ui', 'artifacts'),
      contractPath: join(targetRoot, '.smart-ui', 'design-contract.json'),
      componentId: 'LoginComponent',
      memory: { enabled: false },
    });
    expect(await readFile(first.instructionsPath, 'utf8')).toContain(
      'Call `prepare_workflow` once',
    );
    expect(await readFile(first.hostConfigPath, 'utf8')).toContain('[mcp_servers.smart_ui]');
    expect(await readFile(join(targetRoot, '.smart-ui', 'design', 'login.svg'), 'utf8')).toContain(
      'width="20"',
    );
  });
});
