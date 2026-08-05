export type QuestionCategory = 'blocking' | 'preference' | 'confirmation' | 'review';

export interface InteractionChoice {
  id: string;
  label: string;
  tradeoff: string;
}

export interface InteractionQuestion {
  id: string;
  category: QuestionCategory;
  prompt: string;
  choices?: InteractionChoice[];
  recommendedChoiceId?: string;
  defaultAnswer?: string;
  timeoutMs?: number;
  scope?: string;
}

export interface InteractionAnswer {
  questionId: string;
  answer: string;
  source: 'user' | 'default';
  answeredAt: string;
}

/** Host-neutral question boundary. Hosts own presentation, not decision policy. */
export interface InteractionProvider {
  readonly interactive: boolean;
  ask(question: InteractionQuestion): Promise<InteractionAnswer>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  cancel(reason: string): Promise<void>;
}

/** Deterministic provider for CI. Blocking questions fail unless a safe default exists. */
export class NonInteractiveInteractionProvider implements InteractionProvider {
  readonly interactive = false;

  async ask(question: InteractionQuestion): Promise<InteractionAnswer> {
    if (question.defaultAnswer === undefined) {
      throw new Error(
        `Non-interactive mode cannot answer ${question.category} question '${question.id}' without a configured default.`,
      );
    }
    return {
      questionId: question.id,
      answer: question.defaultAnswer,
      source: 'default',
      answeredAt: new Date().toISOString(),
    };
  }

  async confirm(_message: string, defaultValue = false): Promise<boolean> {
    return defaultValue;
  }

  async cancel(): Promise<void> {}
}

/** Enforces the default pre-implementation question budget. */
export class BudgetedInteractionProvider implements InteractionProvider {
  private preImplementationQuestions = 0;
  readonly interactive: boolean;

  constructor(
    private readonly delegate: InteractionProvider,
    private readonly maximumPreImplementationQuestions = 3,
  ) {
    this.interactive = delegate.interactive;
  }

  async ask(
    question: InteractionQuestion,
    newlyDiscoveredConflict = false,
  ): Promise<InteractionAnswer> {
    if (question.category !== 'review' && !newlyDiscoveredConflict) {
      if (this.preImplementationQuestions >= this.maximumPreImplementationQuestions) {
        throw new Error(`Question budget of ${this.maximumPreImplementationQuestions} exceeded.`);
      }
      this.preImplementationQuestions++;
    }
    return this.delegate.ask(question);
  }

  confirm(message: string, defaultValue?: boolean): Promise<boolean> {
    return this.delegate.confirm(message, defaultValue);
  }

  cancel(reason: string): Promise<void> {
    return this.delegate.cancel(reason);
  }
}

/** Interactive terminal implementation with abortable timeouts and explicit defaults. */
export class TerminalInteractionProvider implements InteractionProvider {
  readonly interactive = true;

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}

  async ask(question: InteractionQuestion): Promise<InteractionAnswer> {
    const terminal = createInterface({ input: this.input, output: this.output });
    const choices =
      question.choices
        ?.map((choice) => `\n  ${choice.id}: ${choice.label} — ${choice.tradeoff}`)
        .join('') ?? '';
    const recommendation = question.recommendedChoiceId
      ? `\nRecommended: ${question.recommendedChoiceId}`
      : '';
    const controller = new AbortController();
    const timer = question.timeoutMs
      ? setTimeout(() => controller.abort(), question.timeoutMs)
      : undefined;
    try {
      const answer = await terminal.question(
        `${question.prompt}${choices}${recommendation}${question.defaultAnswer ? `\nDefault: ${question.defaultAnswer}` : ''}\n> `,
        { signal: controller.signal },
      );
      const normalized = answer.trim() || question.defaultAnswer;
      if (!normalized) throw new Error(`Question '${question.id}' requires an answer.`);
      return {
        questionId: question.id,
        answer: normalized,
        source: answer.trim() ? 'user' : 'default',
        answeredAt: new Date().toISOString(),
      };
    } catch (error) {
      if (controller.signal.aborted && question.defaultAnswer)
        return {
          questionId: question.id,
          answer: question.defaultAnswer,
          source: 'default',
          answeredAt: new Date().toISOString(),
        };
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      terminal.close();
    }
  }

  async confirm(message: string, defaultValue = false): Promise<boolean> {
    const answer = await this.ask({
      id: `confirm-${Date.now()}`,
      category: 'confirmation',
      prompt: `${message} (yes/no)`,
      defaultAnswer: defaultValue ? 'yes' : 'no',
    });
    return ['y', 'yes'].includes(answer.answer.toLowerCase());
  }

  async cancel(reason: string): Promise<void> {
    this.output.write(`Canceled: ${reason}\n`);
  }
}
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
