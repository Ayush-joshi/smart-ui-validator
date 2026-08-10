#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootManifest = await readJson(join(root, 'package.json'));
const packages = [
  { path: 'packages/core', expectedName: 'smart-ui-validator-core' },
  { path: 'apps/cli', expectedName: 'smart-ui-validator' },
  { path: 'apps/mcp-server', expectedName: 'smart-ui-validator-mcp' },
];
const errors = [];
const warnings = [];
const names = new Set();

if (rootManifest.private !== true) {
  errors.push(
    'The workspace root must remain private so fixtures and orchestration files cannot be published.',
  );
}

const licensePath = join(root, 'LICENSE');
if (!(await exists(licensePath))) {
  errors.push(
    'Choose a Smart UI license and add a root LICENSE file before public npm publication.',
  );
}

for (const entry of packages) {
  const directory = join(root, entry.path);
  const manifest = await readJson(join(directory, 'package.json'));
  const label = `${manifest.name ?? entry.path}@${manifest.version ?? 'unknown'}`;

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    errors.push(`${entry.path}: package name is missing.`);
  } else if (names.has(manifest.name)) {
    errors.push(`${entry.path}: duplicate package name ${manifest.name}.`);
  } else {
    names.add(manifest.name);
  }
  if (manifest.name !== entry.expectedName) {
    errors.push(`${entry.path}: package name must be ${entry.expectedName}.`);
  }
  if (manifest.version !== rootManifest.version) {
    errors.push(`${label}: version must match workspace version ${rootManifest.version}.`);
  }
  if (manifest.private === true) errors.push(`${label}: publishable package must not be private.`);
  if (manifest.publishConfig?.access !== 'public') {
    errors.push(`${label}: publishConfig.access must be public.`);
  }
  if (typeof manifest.description !== 'string' || manifest.description.trim().length < 20) {
    errors.push(`${label}: add a meaningful package description.`);
  }
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length < 3) {
    errors.push(`${label}: add at least three discovery keywords.`);
  }
  if (manifest.engines?.node !== rootManifest.engines?.node) {
    errors.push(
      `${label}: Node engine must match workspace requirement ${rootManifest.engines?.node}.`,
    );
  }
  if (!(await exists(join(directory, 'README.md')))) errors.push(`${label}: README.md is missing.`);
  if (manifest.license !== 'MIT') errors.push(`${label}: license must be MIT.`);
  for (const binary of Object.values(manifest.bin ?? {})) {
    if (typeof binary !== 'string') continue;
    const builtBinary = join(directory, binary);
    if (!(await exists(builtBinary))) {
      errors.push(`${label}: built binary is missing: ${binary}. Run pnpm build first.`);
      continue;
    }
    const prefix = (await readFile(builtBinary, 'utf8')).slice(0, 20);
    if (!prefix.startsWith('#!/usr/bin/env node')) {
      errors.push(`${label}: ${binary} must retain its Node shebang.`);
    }
  }

  const packedManifest = await packAndReadManifest(directory, manifest.name);
  if (packedManifest.version !== rootManifest.version) {
    errors.push(`${label}: packed version must be ${rootManifest.version}.`);
  }
  for (const [dependency, specifier] of Object.entries(packedManifest.dependencies ?? {})) {
    if (typeof specifier !== 'string') continue;
    if (/^(?:workspace:|git(?:\+|:)|github:|https?:|file:|link:)/u.test(specifier)) {
      errors.push(
        `${label}: packed dependency ${dependency} still uses non-registry specifier ${specifier}.`,
      );
    }
    if (names.has(dependency) && specifier !== rootManifest.version) {
      errors.push(
        `${label}: packed workspace dependency ${dependency} must resolve to exact version ${rootManifest.version}, found ${specifier}.`,
      );
    }
  }
  if (manifest.name === 'smart-ui-validator') {
    for (const studioAsset of ['dist/studio/server.js', 'dist/studio/public/index.html']) {
      if (!(await exists(join(directory, studioAsset)))) {
        errors.push(`${label}: bundled Studio asset is missing: ${studioAsset}.`);
      }
    }
  }
}

warnings.push(
  'Registry availability is not a reservation. Recheck all three unscoped names immediately before publication.',
);

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  console.error(`\nPublish readiness failed with ${errors.length} blocking issue(s).`);
  process.exit(1);
}
console.log(
  `Publish readiness passed for ${packages.length} packages at version ${rootManifest.version}.`,
);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function packAndReadManifest(directory, packageName) {
  const destination = await mkdtemp(join(tmpdir(), 'smart-ui-publish-check-'));
  execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: directory,
    encoding: 'utf8',
  });
  const tarball = (await readdir(destination)).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error(`${packageName} did not produce a tarball.`);
  return JSON.parse(
    execFileSync('tar', ['-xOf', join(destination, tarball), 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
}
