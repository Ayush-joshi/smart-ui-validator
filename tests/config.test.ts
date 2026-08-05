import { describe, expect, it } from 'vitest';
import { configSchema } from '../packages/core/src/index.js';

describe('Phase 2 configuration', () => {
  it('applies documented defaults', () => {
    const config = configSchema.parse({});
    expect(config.validation.geometryTolerancePx).toBe(2);
    expect(config.validation.maxRepairPasses).toBe(5);
    expect(config.policy.blockExternalNetwork).toBe(true);
    expect(config.memory.backend).toBe('local');
  });

  it('fails closed on unknown or unsafe values', () => {
    expect(() => configSchema.parse({ typo: true })).toThrow();
    expect(() => configSchema.parse({ validation: { geometryTolerancePx: -1 } })).toThrow();
    expect(() => configSchema.parse({ masks: [{ x: 0, y: 0, width: -1, height: 1 }] })).toThrow();
    expect(() => configSchema.parse({ commands: { test: 'pnpm test' } })).toThrow();
  });
});
