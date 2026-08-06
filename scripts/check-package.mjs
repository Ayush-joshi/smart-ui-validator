import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packages = [
  ['@smart-ui/core', 'packages/core'],
  ['@smart-ui/cli', 'apps/cli'],
  ['@smart-ui/mcp-server', 'apps/mcp-server'],
];
const forbidden = [
  /node_modules\//,
  /fixtures\//,
  /tests\//,
  /\.smart-ui\//,
  /playwright-report\//,
  /\.map$/,
];
for (const [name, directory] of packages) {
  const destination = await mkdtemp(join(tmpdir(), 'smart-ui-pack-'));
  execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: resolve(directory),
    encoding: 'utf8',
  });
  const tarball = (await readdir(destination)).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error(`${name} did not produce a tarball.`);
  const files = execFileSync('tar', ['-tzf', join(destination, tarball)], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const rejected = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  if (rejected.length > 0)
    throw new Error(`${name} package contains forbidden files: ${rejected.join(', ')}`);
  console.log(`${name}: ${files.length} package files; forbidden content absent.`);
}
