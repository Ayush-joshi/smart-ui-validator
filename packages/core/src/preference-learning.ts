import type { InteractionProvider, InteractionQuestion } from './interaction.js';
import type { MemoryContext, MemoryProvider, MemoryRecord, MemoryScope } from './memory.js';

export interface PreferenceProposal {
  key: string;
  value: string;
  prompt: string;
  recommendedScope: MemoryScope;
  tradeoff: string;
  evidenceSummary: string;
  runId: string;
}

export interface LearningResult {
  memory: MemoryRecord | null;
  decisions: Array<{ kind: string; message: string }>;
}

/** Coordinates explicit review and consent; it never promotes a preference silently. */
export class PreferenceLearningCoordinator {
  constructor(
    private readonly interaction: InteractionProvider,
    private readonly memory: MemoryProvider,
  ) {}

  async reviewAndPropose(
    proposal: PreferenceProposal,
    context: MemoryContext,
  ): Promise<LearningResult> {
    const question: InteractionQuestion = {
      id: `remember-${proposal.key}`,
      category: 'review',
      prompt: proposal.prompt,
      choices: [
        { id: 'task', label: 'This task', tradeoff: 'Expires with this task.' },
        { id: 'repository', label: 'This repository', tradeoff: proposal.tradeoff },
        { id: 'user', label: 'For me', tradeoff: 'Can apply across repositories.' },
        { id: 'no', label: 'Do not remember', tradeoff: 'No memory is persisted.' },
      ],
      recommendedChoiceId: proposal.recommendedScope.kind,
      defaultAnswer: 'no',
    };
    const answer = await this.interaction.ask(question);
    const decisions = [
      {
        kind: 'interaction',
        message: JSON.stringify({
          question,
          answer,
          downstreamDecision: answer.answer === 'no' ? 'not-persisted' : 'candidate-proposed',
        }),
      },
    ];
    if (answer.answer === 'no') return { memory: null, decisions };

    const scope = scopeFor(answer.answer, proposal, context);
    const now = new Date().toISOString();
    const candidate = await this.memory.propose({
      type: 'preference',
      layer: scope.kind === 'user' ? 'L3' : 'L1',
      value: `${proposal.key}=${proposal.value}`,
      scope,
      selectors: selectorsFor(scope, context),
      identity: { tenantId: context.tenantId, userId: context.userId },
      confidence: 0.75,
      promotionReason: 'User selected a scope during end-of-run review.',
      evidence: [
        { kind: 'interaction', summary: proposal.evidenceSummary },
        { kind: 'run', summary: `Observed in run ${proposal.runId}.` },
      ],
      creator: context.userId,
      sensitivity: 'internal',
      retention: scope.kind === 'task' ? { policy: 'session' } : { policy: 'indefinite' },
      consent: { granted: false, recordedAt: now, actor: context.userId },
    });
    const confirmed = await this.interaction.confirm(
      `Confirm memory ${candidate.id} at ${scope.kind}:${scope.id}?`,
      false,
    );
    if (!confirmed) {
      const rejected = await this.memory.reject(candidate.id);
      decisions.push({
        kind: 'memory',
        message: JSON.stringify({ id: rejected.id, state: rejected.state }),
      });
      return { memory: rejected, decisions };
    }
    const memory = await this.memory.confirm(candidate.id, scope);
    decisions.push({
      kind: 'memory',
      message: JSON.stringify({ id: memory.id, state: memory.state, scope }),
    });
    return { memory, decisions };
  }
}

function scopeFor(
  answer: string,
  proposal: PreferenceProposal,
  context: MemoryContext,
): MemoryScope {
  if (answer === 'task') return { kind: 'task', id: context.taskId ?? proposal.runId };
  if (answer === 'repository') return { kind: 'repository', id: context.repositoryId };
  if (answer === 'user') return { kind: 'user', id: context.userId };
  throw new Error(`Unsupported memory scope answer '${answer}'.`);
}

function selectorsFor(scope: MemoryScope, context: MemoryContext): MemoryRecord['selectors'] {
  if (scope.kind === 'user') return {};
  return {
    repositoryId: context.repositoryId,
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.componentId ? { componentId: context.componentId } : {}),
    ...(scope.kind === 'task' ? { taskId: context.taskId ?? scope.id } : {}),
  };
}
