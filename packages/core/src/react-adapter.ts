import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import type { FrameworkAdapter, RepositoryInspection } from './providers.js';

export class ReactFrameworkAdapter implements FrameworkAdapter {
  readonly framework = 'react';

  async inspect(targetRoot: string): Promise<RepositoryInspection> {
    const root = resolve(targetRoot);
    const packageJson = await readPackageJson(root);
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };
    const files = await topLevelFiles(root);
    const sourceFiles = await filesUnder(join(root, 'src'));
    const hasReact = 'react' in dependencies;
    const buildSystem = detectFirst(dependencies, [
      'vite',
      'next',
      'react-scripts',
      '@rsbuild/core',
    ]);
    const styling = detectAll(dependencies, [
      'styled-components',
      '@emotion/react',
      'tailwindcss',
      'sass',
    ]);
    if (
      files.some((file) => file.endsWith('.module.css')) ||
      sourceFiles.some((file) => file.endsWith('.module.css'))
    ) {
      styling.push('css-modules');
    } else if (sourceFiles.some((file) => file.endsWith('.css'))) {
      styling.push('css');
    }
    const tests = detectAll(dependencies, ['vitest', 'jest', '@playwright/test', 'cypress']);
    const componentLocations = await existingDirectories(root, [
      'src/components',
      'src/app',
      'src/pages',
      'components',
      'src',
    ]);

    return {
      root,
      framework: hasReact ? 'react' : 'unknown',
      buildSystem,
      packageManager: await detectPackageManager(root),
      styling,
      testFrameworks: tests,
      componentLocations,
    };
  }
}

async function readPackageJson(root: string): Promise<PackageJson> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return {};
  }
}

async function topLevelFiles(root: string): Promise<string[]> {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

async function filesUnder(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { recursive: true })).map(String);
  } catch {
    return [];
  }
}

async function existingDirectories(root: string, candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(join(root, candidate));
      found.push(candidate);
    } catch {
      // Expected for absent conventions.
    }
  }
  return found;
}

async function detectPackageManager(root: string): Promise<string | null> {
  let current = root;
  const filesystemRoot = parse(root).root;
  while (true) {
    for (const [file, manager] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
      ['bun.lockb', 'bun'],
    ] as const) {
      try {
        await access(join(current, file));
        return manager;
      } catch {
        // Continue.
      }
    }
    if (current === filesystemRoot) return null;
    current = dirname(current);
  }
}

function detectFirst(dependencies: Record<string, string>, names: string[]): string | null {
  return names.find((name) => name in dependencies) ?? null;
}

function detectAll(dependencies: Record<string, string>, names: string[]): string[] {
  return names.filter((name) => name in dependencies);
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
