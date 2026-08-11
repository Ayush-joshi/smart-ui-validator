import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureStudioAgentHostConfig,
  runStudioAgentSetupChecks,
} from '../packages/core/src/index.js';

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Studio agent bootstrap diagnostics', () => {
  it('creates an absent config idempotently and refuses a differing existing config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-agent-config-'));
    temporaryPaths.push(root);
    const path = join(root, '.codex', 'config.toml');
    expect(await ensureStudioAgentHostConfig(path, 'expected\n', true)).toBe('would-create');
    expect(await ensureStudioAgentHostConfig(path, 'expected\n')).toBe('created');
    expect(await ensureStudioAgentHostConfig(path, 'expected\n')).toBe('unchanged');
    expect(await ensureStudioAgentHostConfig(path, 'different\n')).toBe('different');
  });

  it('reports current runtime assets and one exact stale-build recovery action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smart-ui-agent-check-'));
    temporaryPaths.push(root);
    const workspace = join(root, 'studio-workspace');
    const mcpEntry = join(root, 'runtime', 'mcp.js');
    const source = join(root, 'src', 'server.ts');
    const studioAssets = join(root, 'studio');
    const hostConfig = join(root, '.mcp.json');
    await mkdir(join(studioAssets, 'assets'), { recursive: true });
    await mkdir(join(root, 'runtime'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(mcpEntry, 'export {};\n');
    await writeFile(source, 'export {};\n');
    await writeFile(join(studioAssets, 'index.html'), '<!doctype html>');
    await writeFile(join(studioAssets, 'assets', 'app.js'), '');
    await writeFile(hostConfig, '{"mcpServers":{}}\n');
    const old = new Date(1_000);
    const recent = new Date(2_000);
    await utimes(mcpEntry, old, old);
    await utimes(source, recent, recent);
    const result = await runStudioAgentSetupChecks({
      workspaceRoot: workspace,
      mcpRoot: root,
      mcpEntryPath: mcpEntry,
      studioAssetsRoot: studioAssets,
      host: 'claude',
      hostConfigPath: hostConfig,
      expectedHostConfig: '{"mcpServers":{}}\n',
      sourcePaths: [source],
      skipChromiumProbe: true,
    });
    const stale = result.checks.find((check) => check.name === 'mcp-build');
    expect(stale).toMatchObject({ status: 'fail' });
    expect(stale?.recovery).toMatch(/--ensure-engine.*restart/u);
    expect(result.checks.find((check) => check.name === 'mcp-root')?.status).toBe('pass');
    expect(result.checks.find((check) => check.name === 'studio-assets')?.status).toBe('pass');

    const differing = await runStudioAgentSetupChecks({
      workspaceRoot: workspace,
      mcpRoot: root,
      mcpEntryPath: mcpEntry,
      studioAssetsRoot: studioAssets,
      host: 'claude',
      hostConfigPath: hostConfig,
      expectedHostConfig: '{"mcpServers":{"smart-ui":{}}}\n',
      sourcePaths: [source],
      skipChromiumProbe: true,
    });
    const differingConfig = differing.checks.find((check) => check.name === 'host-config');
    expect(differingConfig).toMatchObject({ status: 'fail' });
    expect(differingConfig?.recovery).toContain('do not overwrite');

    await rm(hostConfig);
    const absent = await runStudioAgentSetupChecks({
      workspaceRoot: workspace,
      mcpRoot: root,
      mcpEntryPath: mcpEntry,
      studioAssetsRoot: studioAssets,
      host: 'claude',
      hostConfigPath: hostConfig,
      expectedHostConfig: '{"mcpServers":{}}\n',
      sourcePaths: [source],
      skipChromiumProbe: true,
    });
    expect(absent.checks.find((check) => check.name === 'host-config')?.recovery).toContain(
      'smart-ui studio --agent --host claude --workspace',
    );
  });
});
