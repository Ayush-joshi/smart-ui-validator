import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReactFrameworkAdapter } from '../packages/core/src/index.js';

describe('ReactFrameworkAdapter', () => {
  it('detects the Vite React fixture conventions without mutation', async () => {
    const result = await new ReactFrameworkAdapter().inspect(resolve('fixtures/react-app'));
    expect(result.framework).toBe('react');
    expect(result.buildSystem).toBe('vite');
    expect(result.packageManager).toBe('pnpm');
    expect(result.styling).toContain('css');
    expect(result.componentLocations).toContain('src');
  });
});
