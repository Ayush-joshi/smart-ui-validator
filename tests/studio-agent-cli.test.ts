import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const cli = resolve('apps/cli/dist/index.js');

describe('smart-ui Studio agent bootstrap CLI', () => {
  it('previews without writes, initializes once, starts Studio, and shares doctor checks', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'smart-ui-agent-cli-')));
    const workspace = join(root, 'studio-workspace');
    const configPath = join(root, '.mcp.json');
    const environment = {
      ...process.env,
      INIT_CWD: root,
      SMART_UI_MCP_ROOT: root,
    };

    let dryRunOutput = '';
    let dryRunCode: number | undefined;
    try {
      await executeFile(
        process.execPath,
        [
          cli,
          'studio',
          '--agent',
          '--host',
          'claude',
          '--workspace',
          workspace,
          '--dry-run',
          '--json',
        ],
        { cwd: resolve('.'), env: environment },
      );
    } catch (error) {
      const failure = error as { stdout: string; code: number };
      dryRunOutput = failure.stdout;
      dryRunCode = failure.code;
    }
    expect(dryRunCode).toBe(4);
    expect(JSON.parse(dryRunOutput)).toMatchObject({
      ready: false,
      dryRun: true,
      host: 'claude',
      configAction: 'would-create',
    });
    await expect(access(configPath)).rejects.toThrow();
    await expect(access(workspace)).rejects.toThrow();

    const { stdout } = await executeFile(
      process.execPath,
      [
        cli,
        'studio',
        '--agent',
        '--host',
        'claude',
        '--workspace',
        workspace,
        '--health-check',
        '--json',
      ],
      { cwd: resolve('.'), env: environment },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      workspace,
      health: { status: 'ready' },
      localOnly: true,
      telemetry: false,
    });
    const config = await readFile(configPath, 'utf8');
    expect(JSON.parse(config)).toMatchObject({
      mcpServers: {
        'smart-ui': {
          command: 'node',
          env: { SMART_UI_MCP_ROOT: root },
        },
      },
    });

    const doctor = await executeFile(
      process.execPath,
      [cli, 'doctor', '--studio-agent', '--host', 'claude', '--workspace', workspace, '--json'],
      { cwd: resolve('.'), env: environment },
    );
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      ready: true,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: 'mcp-build', status: 'pass' }),
        expect.objectContaining({ name: 'studio-assets', status: 'pass' }),
        expect.objectContaining({ name: 'chromium', status: 'pass' }),
        expect.objectContaining({ name: 'host-config', status: 'pass' }),
      ]),
    });
    expect(await readFile(configPath, 'utf8')).toBe(config);
  }, 30_000);
});
