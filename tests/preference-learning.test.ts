import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentMemoryProvider,
  LocalMemoryProvider,
  PreferenceLearningCoordinator,
  type InteractionAnswer,
  type InteractionProvider,
  type InteractionQuestion,
} from '../packages/core/src/index.js';

describe('interactive preference learning demonstration', () => {
  it('asks, applies the answer, confirms scoped memory, and explains reuse in a later run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smart-ui-learning-'));
    const memory = new AgentMemoryProvider(
      new LocalMemoryProvider(join(directory, 'memory.json')),
      { databasePath: join(directory, 'agent-memory.sqlite') },
    );
    const interaction = new ScriptedInteractionProvider(['repository'], [true]);
    const coordinator = new PreferenceLearningCoordinator(interaction, memory);
    const context = {
      tenantId: 'local',
      userId: 'developer',
      repositoryId: '/work/repository-a',
      projectId: 'smart-ui',
      taskId: 'run-one',
    };

    const learned = await coordinator.reviewAndPropose(
      {
        key: 'spacing-source',
        value: 'repository-tokens',
        prompt: 'Remember that repository spacing tokens outrank isolated inferred spacing?',
        recommendedScope: { kind: 'repository', id: context.repositoryId },
        tradeoff: 'Reused only in this repository.',
        evidenceSummary: 'The accepted implementation reused existing spacing tokens.',
        runId: 'run-one',
      },
      context,
    );
    expect(interaction.questions).toHaveLength(1);
    expect(learned.memory).toMatchObject({
      state: 'confirmed',
      scope: { kind: 'repository', id: context.repositoryId },
    });
    expect(learned.decisions[0]?.message).toContain('downstreamDecision');

    const later = await memory.recall(
      { ...context, taskId: 'run-two' },
      { maxRecords: 5, maxCharactersPerMemory: 200, maxTotalCharacters: 1_000 },
    );
    expect(later.context).toContain('spacing-source=repository-tokens');
    const explanation = await memory.explain(learned.memory!.id, { ...context, taskId: 'run-two' });
    expect(explanation).toMatchObject({ eligible: true });
    await memory.close();
  });
});

class ScriptedInteractionProvider implements InteractionProvider {
  readonly interactive = true;
  readonly questions: InteractionQuestion[] = [];

  constructor(
    private readonly answers: string[],
    private readonly confirmations: boolean[],
  ) {}

  async ask(question: InteractionQuestion): Promise<InteractionAnswer> {
    this.questions.push(question);
    const answer = this.answers.shift();
    if (!answer) throw new Error('Missing scripted answer.');
    return {
      questionId: question.id,
      answer,
      source: 'user',
      answeredAt: '2026-08-06T00:00:00.000Z',
    };
  }

  async confirm(): Promise<boolean> {
    return this.confirmations.shift() ?? false;
  }

  async cancel(): Promise<void> {}
}
