import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AngularFrameworkAdapter } from './angular-adapter.js';
import type { FrameworkAdapter, RepositoryInspection } from './providers.js';
import { ReactFrameworkAdapter } from './react-adapter.js';

/** Chooses one production framework adapter from package evidence without mutating the target. */
export class AutoFrameworkAdapter implements FrameworkAdapter {
  readonly framework = 'auto';

  async inspect(targetRoot: string): Promise<RepositoryInspection> {
    let dependencies: Record<string, string> = {};
    try {
      const packageJson = JSON.parse(await readFile(join(targetRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      dependencies = {
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
      };
    } catch {
      // The concrete adapter returns explicit ambiguity evidence.
    }
    if ('@angular/core' in dependencies) return new AngularFrameworkAdapter().inspect(targetRoot);
    return new ReactFrameworkAdapter().inspect(targetRoot);
  }
}
