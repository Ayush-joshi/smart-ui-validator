#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'smart-ui-clean-consumer-'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const candidates = [
  ['packages/core', 'smart-ui-validator-core'],
  ['apps/cli', 'smart-ui-validator'],
  ['apps/mcp-server', 'smart-ui-validator-mcp'],
];

try {
  for (const [source] of candidates) {
    execFileSync('pnpm', ['pack', '--pack-destination', directory], {
      cwd: join(root, source),
      stdio: 'inherit',
    });
  }
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify({ name: 'smart-ui-clean-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  execFileSync(
    'npm',
    ['install', ...candidates.map(([, name]) => join(directory, `${name}-${version}.tgz`))],
    {
      cwd: directory,
      stdio: 'inherit',
    },
  );
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const core=await import('smart-ui-validator-core'); if(typeof core.runSetup!=='function') process.exit(1);",
    ],
    { cwd: directory, stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [join(directory, 'node_modules', 'smart-ui-validator', 'dist', 'index.js'), '--version'],
    { cwd: directory, stdio: 'inherit' },
  );
  const studioWorkspace = await mkdtemp(join(tmpdir(), 'smart-ui-packed-studio-'));
  const cli = join(directory, 'node_modules', 'smart-ui-validator', 'dist', 'index.js');
  execFileSync(
    process.execPath,
    [cli, 'studio', '--workspace', studioWorkspace, '--init-only', '--json'],
    {
      cwd: directory,
      stdio: 'inherit',
    },
  );
  execFileSync(
    process.execPath,
    [cli, 'studio', '--workspace', studioWorkspace, '--health-check', '--json'],
    { cwd: directory, stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const mcp=await import('smart-ui-validator-mcp'); if(typeof mcp.createSmartUiMcpServer!=='function') process.exit(1);",
    ],
    { cwd: directory, stdio: 'inherit' },
  );
  execFileSync('npm', ['audit', '--audit-level', 'high'], {
    cwd: directory,
    stdio: 'inherit',
  });
  console.log('Clean npm consumer check passed.');
} catch {
  console.error('Clean npm consumer check failed. Review the command output above.');
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
