import { describe, expect, it } from 'vitest';
import {
  BudgetedInteractionProvider,
  NonInteractiveInteractionProvider,
} from '../packages/core/src/index.js';

describe('interaction policy', () => {
  it('uses explicit safe defaults in non-interactive mode and never waits', async () => {
    const provider = new NonInteractiveInteractionProvider();
    await expect(
      provider.ask({ id: 'responsive', category: 'blocking', prompt: 'Stack cards?' }),
    ).rejects.toThrow(/without a configured default/);
    await expect(
      provider.ask({
        id: 'responsive',
        category: 'blocking',
        prompt: 'Stack cards?',
        defaultAnswer: 'stack',
      }),
    ).resolves.toMatchObject({ answer: 'stack', source: 'default' });
  });

  it('limits ordinary pre-implementation questions to three', async () => {
    const provider = new BudgetedInteractionProvider(new NonInteractiveInteractionProvider());
    for (let index = 0; index < 3; index++)
      await provider.ask({
        id: `question-${index}`,
        category: 'preference',
        prompt: 'Choose',
        defaultAnswer: 'safe',
      });
    await expect(
      provider.ask({
        id: 'fourth',
        category: 'preference',
        prompt: 'Choose',
        defaultAnswer: 'safe',
      }),
    ).rejects.toThrow(/budget/);
  });
});
