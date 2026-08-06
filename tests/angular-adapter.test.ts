import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AngularFrameworkAdapter, AutoFrameworkAdapter } from '../packages/core/src/index.js';

describe('AngularFrameworkAdapter', () => {
  it('discovers native standalone, signal, component, and token evidence without mutation', async () => {
    const root = resolve('fixtures/angular-app');
    const result = await new AngularFrameworkAdapter().inspect(root);
    expect(result).toMatchObject({ framework: 'angular', buildSystem: '@angular/build' });
    expect(result.conventions).toContain('standalone-components');
    expect(result.conventions).toContain('signals');
    expect(result.componentCandidates).toContainEqual(
      expect.objectContaining({ name: 'FixtureCardComponent', selector: 'app-root' }),
    );
    expect(result.designTokens).toContainEqual(
      expect.objectContaining({ name: '--brand', kind: 'css-custom-property' }),
    );
    expect((await new AutoFrameworkAdapter().inspect(root)).framework).toBe('angular');
  });
});
