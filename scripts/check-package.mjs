import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pnpm } from './pnpm-command.mjs';

const packages = [
  ['smart-ui-validator-core', 'packages/core'],
  ['smart-ui-validator', 'apps/cli'],
  ['smart-ui-validator-mcp', 'apps/mcp-server'],
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
  pnpm(['pack', '--pack-destination', destination], {
    cwd: resolve(directory),
    encoding: 'utf8',
  });
  const tarball = (await readdir(destination)).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error(`${name} did not produce a tarball.`);
  const files = execFileSync('tar', ['-tzf', join(destination, tarball)], {
    encoding: 'utf8',
  })
    .split(/\r?\n/u)
    .map((file) => file.trim())
    .filter(Boolean);
  const rejected = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  if (rejected.length > 0)
    throw new Error(`${name} package contains forbidden files: ${rejected.join(', ')}`);
  if (!files.includes('package/LICENSE')) throw new Error(`${name} package is missing LICENSE.`);
  if (name === 'smart-ui-validator') {
    const studioFiles = ['package/dist/studio/server.js', 'package/dist/studio/public/index.html'];
    for (const file of studioFiles) {
      if (!files.includes(file)) throw new Error(`${name} package is missing ${file}.`);
    }
    if (!files.some((file) => /^package\/dist\/studio\/public\/assets\/.*\.js$/u.test(file))) {
      throw new Error(`${name} package is missing the built Studio client JavaScript.`);
    }
    if (!files.some((file) => /^package\/dist\/studio\/public\/assets\/.*\.css$/u.test(file))) {
      throw new Error(`${name} package is missing the built Studio client stylesheet.`);
    }
  }
  console.log(`${name}: ${files.length} package files; forbidden content absent.`);
}
