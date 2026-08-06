import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  detectAll,
  detectFirst,
  detectPackageManager,
  discoverDesignTokens,
  discoverRepository,
  existingDirectories,
} from './framework-discovery.js';
import type { FrameworkAdapter, RepositoryInspection } from './providers.js';

/** Read-only React discovery for Vite, Next.js, CRA and Rsbuild repositories. */
export class ReactFrameworkAdapter implements FrameworkAdapter {
  readonly framework = 'react';

  async inspect(targetRoot: string): Promise<RepositoryInspection> {
    const root = resolve(targetRoot);
    const { dependencies, files } = await discoverRepository(root);
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
      '@vanilla-extract/css',
    ]);
    if (files.some((file) => file.endsWith('.module.css'))) styling.push('css-modules');
    else if (files.some((file) => file.endsWith('.css'))) styling.push('css');

    const routing = detectAll(dependencies, [
      'next',
      'react-router',
      'react-router-dom',
      '@tanstack/react-router',
    ]);
    const stateManagement = detectAll(dependencies, [
      'redux',
      '@reduxjs/toolkit',
      'zustand',
      'mobx',
      'jotai',
      'xstate',
    ]);
    const componentCandidates: NonNullable<RepositoryInspection['componentCandidates']> = [];
    for (const file of files.filter((item) => /\.(tsx|jsx)$/.test(item)).slice(0, 1_000)) {
      let content = '';
      try {
        content = await readFile(join(root, file), 'utf8');
      } catch {
        continue;
      }
      const names = [
        ...content.matchAll(
          /export\s+(?:default\s+)?(?:function|class|const)\s+([A-Z][A-Za-z0-9_]*)/g,
        ),
      ];
      for (const match of names.slice(0, 20)) {
        if (match[1])
          componentCandidates.push({ name: match[1], relativePath: file, kind: 'component' });
      }
      if (names.length === 0 && /^[A-Z]/.test(basename(file))) {
        componentCandidates.push({
          name: basename(file).replace(/\.[^.]+$/, ''),
          relativePath: file,
          kind: 'component',
        });
      }
    }
    const storybook =
      files.some((file) => /\.stories\.(tsx|jsx|ts|js|mdx)$/.test(file)) ||
      '@storybook/react' in dependencies;
    const conventions = [
      buildSystem ? `${buildSystem}-build` : 'unknown-build',
      files.some((file) => file.startsWith('src/app/')) ? 'app-router' : '',
      files.some((file) => file.startsWith('src/pages/')) ? 'pages-router' : '',
      files.some((file) => file.endsWith('.module.css')) ? 'co-located-css-modules' : '',
      storybook ? 'storybook' : '',
    ].filter(Boolean);
    return {
      root,
      framework: hasReact ? 'react' : 'unknown',
      buildSystem,
      packageManager: await detectPackageManager(root),
      styling: [...new Set(styling)].sort(),
      testFrameworks: detectAll(dependencies, ['vitest', 'jest', '@playwright/test', 'cypress']),
      componentLocations: await existingDirectories(root, [
        'src/components',
        'src/app',
        'src/pages',
        'components',
        'src',
      ]),
      routing,
      stateManagement,
      storybook,
      componentCandidates: deduplicateComponents(componentCandidates),
      designTokens: await discoverDesignTokens(root, files),
      conventions,
      ambiguities: [
        ...(!hasReact ? ['React dependency was not found.'] : []),
        ...(!buildSystem ? ['No supported React build system was detected.'] : []),
        ...(componentCandidates.length === 0
          ? ['No exported React component candidates were found.']
          : []),
      ],
    };
  }
}

function deduplicateComponents(
  candidates: NonNullable<RepositoryInspection['componentCandidates']>,
) {
  return [
    ...new Map(candidates.map((item) => [`${item.relativePath}:${item.name}`, item])).values(),
  ].slice(0, 1_000);
}
