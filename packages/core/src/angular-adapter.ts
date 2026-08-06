import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  detectAll,
  detectPackageManager,
  discoverDesignTokens,
  discoverRepository,
  existingDirectories,
} from './framework-discovery.js';
import type { FrameworkAdapter, RepositoryInspection } from './providers.js';

/** Read-only Angular discovery that preserves native standalone/module and reactive conventions. */
export class AngularFrameworkAdapter implements FrameworkAdapter {
  readonly framework = 'angular';

  async inspect(targetRoot: string): Promise<RepositoryInspection> {
    const root = resolve(targetRoot);
    const { dependencies, files } = await discoverRepository(root);
    const hasAngular = '@angular/core' in dependencies;
    const components: NonNullable<RepositoryInspection['componentCandidates']> = [];
    let standaloneCount = 0;
    let signalCount = 0;
    let observableCount = 0;
    for (const file of files
      .filter((item) => /\.(component|directive|service)\.ts$/.test(item))
      .slice(0, 1_000)) {
      let content = '';
      try {
        content = await readFile(join(root, file), 'utf8');
      } catch {
        continue;
      }
      const name =
        content.match(/export\s+class\s+([A-Za-z0-9_]+)/)?.[1] ?? basename(file).split('.')[0]!;
      const selector = content.match(/selector\s*:\s*['"]([^'"]+)['"]/)?.[1];
      const kind = file.endsWith('.directive.ts')
        ? 'directive'
        : file.endsWith('.service.ts')
          ? 'service'
          : 'component';
      components.push({ name, relativePath: file, kind, ...(selector ? { selector } : {}) });
      if (/standalone\s*:\s*true/.test(content)) standaloneCount++;
      if (/\b(?:signal|computed|effect)\s*\(/.test(content)) signalCount++;
      if (/\b(?:Observable|Subject|BehaviorSubject)\b/.test(content)) observableCount++;
    }
    const moduleCount = files.filter((file) => file.endsWith('.module.ts')).length;
    const styling = detectAll(dependencies, [
      'tailwindcss',
      'sass',
      '@angular/material',
      '@ng-bootstrap/ng-bootstrap',
    ]);
    if (files.some((file) => file.endsWith('.scss'))) styling.push('scss');
    else if (files.some((file) => file.endsWith('.css'))) styling.push('css');
    const storybook =
      files.some((file) => /\.stories\.ts$/.test(file)) || '@storybook/angular' in dependencies;
    return {
      root,
      framework: hasAngular ? 'angular' : 'unknown',
      buildSystem:
        '@angular/build' in dependencies
          ? '@angular/build'
          : '@angular-devkit/build-angular' in dependencies
            ? '@angular-devkit/build-angular'
            : null,
      packageManager: await detectPackageManager(root),
      styling: [...new Set(styling)].sort(),
      testFrameworks: detectAll(dependencies, [
        'vitest',
        'jest',
        'jasmine-core',
        'karma',
        '@playwright/test',
        'cypress',
      ]),
      componentLocations: await existingDirectories(root, [
        'src/app/components',
        'src/app',
        'projects',
        'src',
      ]),
      routing: detectAll(dependencies, ['@angular/router']),
      stateManagement: detectAll(dependencies, [
        '@ngrx/store',
        '@ngrx/signals',
        '@ngxs/store',
        'rxjs',
      ]),
      storybook,
      componentCandidates: components,
      designTokens: await discoverDesignTokens(root, files),
      conventions: [
        standaloneCount > 0 ? 'standalone-components' : '',
        moduleCount > 0 ? 'ng-modules' : '',
        signalCount > 0 ? 'signals' : '',
        observableCount > 0 ? 'observables' : '',
        storybook ? 'storybook' : '',
      ].filter(Boolean),
      ambiguities: [
        ...(!hasAngular ? ['Angular core dependency was not found.'] : []),
        ...(standaloneCount > 0 && moduleCount > 0
          ? [
              'Repository mixes standalone components and NgModules; preserve the nearest component convention.',
            ]
          : []),
        ...(components.length === 0
          ? ['No Angular component, directive, or service candidates were found.']
          : []),
      ],
    };
  }
}
