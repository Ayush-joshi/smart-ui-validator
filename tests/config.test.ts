import { describe, expect, it } from 'vitest';
import { configSchema } from '../packages/core/src/index.js';

describe('Phase 2 configuration', () => {
  it('applies documented defaults', () => {
    const config = configSchema.parse({});
    expect(config.validation.geometryTolerancePx).toBe(2);
    expect(config.validation.maxRepairPasses).toBe(5);
    expect(config.policy.blockExternalNetwork).toBe(true);
    expect(config.memory.backend).toBe('local');
    expect(config.generation).toMatchObject({
      artifactBase: '.smart-ui/generations',
      maxPasses: 1,
      maxProposalRegressionPercent: 0,
      narrowViewportWidth: 375,
    });
  });

  it('fails closed on unknown or unsafe values', () => {
    expect(() => configSchema.parse({ typo: true })).toThrow();
    expect(() => configSchema.parse({ validation: { geometryTolerancePx: -1 } })).toThrow();
    expect(() => configSchema.parse({ masks: [{ x: 0, y: 0, width: -1, height: 1 }] })).toThrow();
    expect(() => configSchema.parse({ commands: { test: 'pnpm test' } })).toThrow();
    expect(() => configSchema.parse({ generation: { maxPasses: 2 } })).toThrow();
  });

  it('requires selectors for pointer and keyboard interaction states', () => {
    expect(() => configSchema.parse({ states: [{ name: 'hover' }] })).toThrow(
      "State 'hover' requires a selector.",
    );
    expect(
      configSchema.parse({ states: [{ name: 'focus', selector: '[data-testid="submit"]' }] })
        .states,
    ).toEqual([{ name: 'focus', selector: '[data-testid="submit"]' }]);
  });

  it('fails closed when project configuration conflicts with enterprise policy', () => {
    expect(() => configSchema.parse({ enterprise: { remoteMcpEnabled: true } })).toThrow(
      'Remote MCP requires enterprise mode',
    );

    expect(() =>
      configSchema.parse({
        enterprise: { enabled: true },
        policy: { blockExternalNetwork: false },
      }),
    ).toThrow('Administrative policy does not permit browser networking.');

    expect(() =>
      configSchema.parse({
        enterprise: { enabled: true },
        memory: { learningEnabled: true },
      }),
    ).toThrow('Administrative policy does not permit learning.');
  });
});
