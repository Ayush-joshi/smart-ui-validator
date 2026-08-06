import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, parse, relative } from 'node:path';
import type { RepositoryInspection } from './providers.js';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.smart-ui',
  'coverage',
  'dist',
  'build',
  'node_modules',
  '.next',
  '.angular',
]);
const MAX_DISCOVERY_FILES = 10_000;
const MAX_DISCOVERY_BYTES = 256_000;

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export async function discoverRepository(root: string): Promise<{
  packageJson: PackageJson;
  dependencies: Record<string, string>;
  files: string[];
}> {
  const packageJson = await readPackageJson(root);
  return {
    packageJson,
    dependencies: { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) },
    files: await walkFiles(root),
  };
}

export function detectFirst(dependencies: Record<string, string>, names: string[]): string | null {
  return names.find((name) => name in dependencies) ?? null;
}

export function detectAll(dependencies: Record<string, string>, names: string[]): string[] {
  return names.filter((name) => name in dependencies);
}

export async function detectPackageManager(root: string): Promise<string | null> {
  let current = root;
  const filesystemRoot = parse(root).root;
  while (true) {
    for (const [file, manager] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
      ['bun.lockb', 'bun'],
      ['bun.lock', 'bun'],
    ] as const) {
      try {
        await access(join(current, file));
        return manager;
      } catch {
        // Continue toward the filesystem root.
      }
    }
    if (current === filesystemRoot) return null;
    current = dirname(current);
  }
}

export async function existingDirectories(root: string, candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(join(root, candidate));
      found.push(candidate);
    } catch {
      // An absent convention is expected discovery evidence.
    }
  }
  return found;
}

export async function discoverDesignTokens(
  root: string,
  files: string[],
): Promise<NonNullable<RepositoryInspection['designTokens']>> {
  const tokens: NonNullable<RepositoryInspection['designTokens']> = [];
  for (const file of files.filter(isTokenCandidate).slice(0, 250)) {
    let source: string;
    try {
      source = await readFile(join(root, file), 'utf8');
    } catch {
      continue;
    }
    if (source.length > MAX_DISCOVERY_BYTES) continue;
    const kind = file.endsWith('.scss')
      ? 'scss'
      : file.endsWith('.css')
        ? 'css-custom-property'
        : 'typescript';
    const expressions =
      kind === 'css-custom-property'
        ? [...source.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)/g)].map((match) => [
            match[1],
            match[2],
          ])
        : kind === 'scss'
          ? [...source.matchAll(/(\$[a-zA-Z0-9_-]+)\s*:\s*([^;]+)/g)].map((match) => [
              match[1],
              match[2],
            ])
          : [...source.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*([^;\n]+)/g)].map(
              (match) => [match[1], match[2]],
            );
    for (const [name, value] of expressions.slice(0, 200)) {
      if (!name || tokens.some((token) => token.name === name && token.source === file)) continue;
      tokens.push({
        name,
        source: file,
        kind,
        ...(value ? { value: value.trim().slice(0, 160) } : {}),
      });
    }
  }
  return tokens.slice(0, 1_000);
}

function isTokenCandidate(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    lower.endsWith('.css') ||
    lower.endsWith('.scss') ||
    ((lower.includes('token') || lower.includes('theme')) && /\.(ts|tsx|js|jsx)$/.test(lower))
  );
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const queue = [''];
  while (queue.length > 0 && result.length < MAX_DISCOVERY_FILES) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, current), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (result.length >= MAX_DISCOVERY_FILES) break;
      const path = current ? join(current, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        result.push(path);
      }
    }
  }
  return result.map((file) => relative(root, join(root, file)));
}

async function readPackageJson(root: string): Promise<PackageJson> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return {};
  }
}
