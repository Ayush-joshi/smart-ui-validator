import { isAbsolute, resolve } from 'node:path';
import { Option } from 'commander';
import type { Command } from 'commander';
import {
  SmartUiError,
  acceptHandoffAttempt,
  cancelHandoffTask,
  loadHandoffTask,
  prepareGenerationTask,
  prepareImplementationTask,
  projectHandoffTask,
  quoteArgument,
  readHandoffAttemptResult,
  reviewGenerationTask,
  reviewImplementationTask,
  withHandoffTaskLock,
  type GenerationLayout,
  type GenerationMode,
} from 'smart-ui-validator-core';

interface PrepareOptions {
  workspace: string;
  design: string;
  designContext?: string;
  structuredContext?: string;
  presentation?: string;
  mode: GenerationMode;
  layout: GenerationLayout;
  name?: string;
  instructions?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface ReviewOptions {
  task: string;
  author?: string;
  note?: string;
  open?: boolean;
  json?: boolean;
}

interface PrepareImplementationOptions {
  target: string;
  design: string;
  designContext?: string;
  structuredContext?: string;
  presentation?: string;
  route: string;
  allowWrite: string[];
  instructions?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface HandoffCliDependencies {
  invocationRoot: string;
  print: (value: unknown, json?: boolean) => void;
  userPath: (path: string) => string;
  openStudioReview: (taskFile: string, attempt: number) => Promise<void>;
}

/** Registers the host-neutral handoff commands. None of them invokes a model or waits for an agent. */
export function registerHandoffCommands(
  program: Command,
  dependencies: HandoffCliDependencies,
): void {
  const generation = program
    .command('generation')
    .description('Prepare and review standalone generation handoff tasks');

  generation
    .command('prepare')
    .description('Create a persistent generation task for an agent or a human, without MCP')
    .requiredOption('--workspace <path>', 'exact workspace and containment boundary')
    .requiredOption('--design <path>', 'local SVG or PNG inside the workspace')
    .option('--design-context <path>', 'bounded UTF-8 source context inside the workspace')
    .option('--structured-context <path>', 'StructuredDesignContext 1.0 JSON inside the workspace')
    .option('--presentation <path>', 'PresentationSpec 1.0 JSON inside the workspace')
    .addOption(
      new Option('--mode <mode>').choices(['exact', 'hybrid', 'semantic']).default('hybrid'),
    )
    .addOption(
      new Option('--layout <layout>')
        .choices(['fixed', 'responsive', 'component'])
        .default('responsive'),
    )
    .option('--name <name>', 'friendly generated UI name')
    .option('--instructions <text>', 'bounded literal implementation note')
    .option('--dry-run', 'inspect and print the proposed handoff without creating a task')
    .option('--json', 'emit one compact JSON result')
    .action(async (options: PrepareOptions) => {
      const workspace = dependencies.userPath(options.workspace);
      const preparation = await prepareGenerationTask({
        workspace,
        designPath: dependencies.userPath(options.design),
        ...(options.designContext
          ? { designContextPath: dependencies.userPath(options.designContext) }
          : {}),
        ...(options.structuredContext
          ? { structuredContextPath: dependencies.userPath(options.structuredContext) }
          : {}),
        ...(options.presentation
          ? { presentationPath: dependencies.userPath(options.presentation) }
          : {}),
        mode: options.mode,
        layout: options.layout,
        ...(options.name ? { name: options.name } : {}),
        ...(options.instructions ? { instructions: options.instructions } : {}),
        dryRun: options.dryRun ?? false,
      });
      const summary = {
        ...projectHandoffTask(preparation.task, preparation.state),
        dryRun: preparation.dryRun,
        instructionsFile: preparation.instructionsFile,
        proposalDirectory: preparation.proposalDirectory,
      };
      if (options.json) {
        dependencies.print(summary, true);
        return;
      }
      printPreparation(summary);
    });

  generation
    .command('review')
    .description('Deterministically review the authored proposal for one generation task')
    .requiredOption('--task <path>', 'absolute path to task.json')
    .option('--author <name>', 'who authored this attempt', 'external')
    .option('--note <text>', 'bounded attempt note')
    .option('--open', 'open the reviewed attempt in Studio')
    .option('--json', 'emit one compact JSON result')
    .action(async (options: ReviewOptions) => {
      if (options.open && options.json) {
        throw new SmartUiError(
          'INVALID_INPUT',
          '--json is headless and cannot be used with --open.',
        );
      }
      const taskFile = absoluteTaskPath(options.task, dependencies.invocationRoot);
      const outcome = await reviewGenerationTask({
        taskFile,
        author: options.author ?? 'external',
        source: 'cli',
        ...(options.note ? { note: options.note } : {}),
      });
      const summary = {
        schemaVersion: '1.0' as const,
        taskId: outcome.task.taskId,
        taskFile,
        attempt: outcome.attempt,
        attemptDirectory: outcome.attemptRoot,
        status: outcome.state.status,
        revision: outcome.state.revision,
        outcome: outcome.result.outcome,
        findingCount: outcome.result.findingCount,
        blockingFindingCount: outcome.result.blockingFindingCount,
        visualSimilarityPercent: outcome.result.generation?.visualSimilarityPercent ?? null,
        warnings: outcome.result.warnings,
        failures: outcome.result.failures,
        revisionGuidance: outcome.result.revisionGuidance,
        generation: outcome.result.generation ?? null,
        nextCommand:
          outcome.result.outcome === 'passed'
            ? `smart-ui task accept --task ${quoteArgument(taskFile)} --attempt ${outcome.attempt}`
            : outcome.task.commands.review,
        studioCommand: `smart-ui studio --review-task ${quoteArgument(taskFile)}`,
      };
      if (options.json) {
        dependencies.print(summary, true);
      } else {
        printReview(summary);
      }
      if (outcome.result.outcome !== 'passed') process.exitCode = 4;
      if (options.open) await dependencies.openStudioReview(taskFile, outcome.attempt);
    });

  const validateUi = program
    .command('validate-ui')
    .description('Prepare and review bounded existing-UI implementation tasks');

  validateUi
    .command('prepare')
    .description('Inspect a React or Angular target and create an exact-write handoff task')
    .requiredOption('--target <path>', 'exact target repository and containment boundary')
    .requiredOption('--design <path>', 'local SVG or PNG inside the target repository')
    .requiredOption('--route <url>', 'already-running route to review')
    .requiredOption(
      '--allow-write <path>',
      'exact target-relative UTF-8 source file; repeat for each file',
      collectValue,
      [],
    )
    .option('--design-context <path>', 'bounded UTF-8 source context inside the target')
    .option('--structured-context <path>', 'StructuredDesignContext 1.0 JSON inside the target')
    .option('--presentation <path>', 'PresentationSpec 1.0 JSON inside the target')
    .option('--instructions <text>', 'bounded literal implementation note')
    .option('--dry-run', 'inspect and print the proposed handoff without creating a task')
    .option('--json', 'emit one compact JSON result')
    .action(async (options: PrepareImplementationOptions) => {
      const preparation = await prepareImplementationTask({
        target: dependencies.userPath(options.target),
        designPath: dependencies.userPath(options.design),
        route: options.route,
        writableFiles: options.allowWrite,
        ...(options.designContext
          ? { designContextPath: dependencies.userPath(options.designContext) }
          : {}),
        ...(options.structuredContext
          ? { structuredContextPath: dependencies.userPath(options.structuredContext) }
          : {}),
        ...(options.presentation
          ? { presentationPath: dependencies.userPath(options.presentation) }
          : {}),
        ...(options.instructions ? { instructions: options.instructions } : {}),
        dryRun: options.dryRun ?? false,
      });
      const summary = {
        ...projectHandoffTask(preparation.task, preparation.state),
        dryRun: preparation.dryRun,
        instructionsFile: preparation.instructionsFile,
      };
      if (options.json) {
        dependencies.print(summary, true);
        return;
      }
      printImplementationPreparation(summary);
    });

  validateUi
    .command('review')
    .description('Capture and deterministically review the declared running route and matrix')
    .requiredOption('--task <path>', 'absolute path to task.json')
    .option('--author <name>', 'who authored this attempt', 'external')
    .option('--note <text>', 'bounded attempt note')
    .option('--open', 'open the reviewed attempt in Studio')
    .option('--json', 'emit one compact JSON result')
    .action(async (options: ReviewOptions) => {
      if (options.open && options.json) {
        throw new SmartUiError(
          'INVALID_INPUT',
          '--json is headless and cannot be used with --open.',
        );
      }
      const taskFile = absoluteTaskPath(options.task, dependencies.invocationRoot);
      const outcome = await reviewImplementationTask({
        taskFile,
        author: options.author ?? 'external',
        source: 'cli',
        ...(options.note ? { note: options.note } : {}),
      });
      const summary = {
        schemaVersion: '1.0' as const,
        taskId: outcome.task.taskId,
        taskFile,
        attempt: outcome.attempt,
        attemptDirectory: outcome.attemptRoot,
        status: outcome.state.status,
        revision: outcome.state.revision,
        outcome: outcome.result.outcome,
        findingCount: outcome.result.findingCount,
        blockingFindingCount: outcome.result.blockingFindingCount,
        changedFiles: outcome.result.implementation?.changedFiles ?? [],
        cells: outcome.index.cells,
        revisionGuidance: outcome.result.revisionGuidance,
        nextCommand:
          outcome.result.outcome === 'passed'
            ? `smart-ui task accept --task ${quoteArgument(taskFile)} --attempt ${outcome.attempt}`
            : outcome.task.commands.review,
        studioCommand: `smart-ui studio --review-task ${quoteArgument(taskFile)}`,
      };
      if (options.json) dependencies.print(summary, true);
      else printImplementationReview(summary);
      if (outcome.result.outcome !== 'passed') process.exitCode = 4;
      if (options.open) await dependencies.openStudioReview(taskFile, outcome.attempt);
    });

  const task = program.command('task').description('Shared handoff task lifecycle');

  task
    .command('status')
    .requiredOption('--task <path>', 'absolute path to task.json')
    .option('--json', 'emit one compact JSON result')
    .action(async (options: { task: string; json?: boolean }) => {
      const taskFile = absoluteTaskPath(options.task, dependencies.invocationRoot);
      const loaded = await loadHandoffTask(taskFile);
      const active = loaded.state.activeAttempt;
      dependencies.print(
        {
          ...projectHandoffTask(loaded.task, loaded.state),
          lastResult: active
            ? ((await readHandoffAttemptResult(loaded.taskRoot, active)) ?? null)
            : null,
        },
        options.json,
      );
    });

  task
    .command('accept')
    .description('Record an explicit decision; this never commits, pushes, or deploys anything')
    .requiredOption('--task <path>', 'absolute path to task.json')
    .requiredOption('--attempt <number>', 'reviewed attempt to accept', parseAttempt)
    .option('--json', 'emit one compact JSON result')
    .action(async (options: { task: string; attempt: number; json?: boolean }) => {
      const taskFile = absoluteTaskPath(options.task, dependencies.invocationRoot);
      const loaded = await loadHandoffTask(taskFile);
      const state = await withHandoffTaskLock(loaded.taskRoot, () =>
        acceptHandoffAttempt(loaded.taskRoot, loaded.state, options.attempt),
      );
      dependencies.print(projectHandoffTask(loaded.task, state), options.json);
    });

  task
    .command('cancel')
    .requiredOption('--task <path>', 'absolute path to task.json')
    .option('--json', 'emit one compact JSON result')
    .action(async (options: { task: string; json?: boolean }) => {
      const taskFile = absoluteTaskPath(options.task, dependencies.invocationRoot);
      const loaded = await loadHandoffTask(taskFile);
      const state = await withHandoffTaskLock(loaded.taskRoot, () =>
        cancelHandoffTask(loaded.taskRoot, loaded.state),
      );
      dependencies.print(projectHandoffTask(loaded.task, state), options.json);
    });
}

function printPreparation(summary: {
  dryRun: boolean;
  taskId: string;
  taskFile: string;
  instructionsFile: string;
  proposalDirectory: string;
  writableFiles: readonly string[];
  commands: { review: string; status: string; cancel: string; mcp: string };
}): void {
  const lines = [
    summary.dryRun
      ? 'Dry run: no task, queue, or artifact was created.'
      : `Prepared generation task ${summary.taskId}.`,
    '',
    `Task contract:   ${summary.taskFile}`,
    `Instructions:    ${summary.instructionsFile}`,
    `Write only into: ${summary.proposalDirectory}`,
    `Exact manifest:  ${summary.writableFiles.join(', ')}, plus optional assets/<name>.svg`,
    '',
    'Continue with an external agent or a human, then run:',
    `  ${summary.commands.review}`,
    '',
    'Or continue with a connected MCP agent:',
    `  ${summary.commands.mcp}`,
  ];
  console.log(lines.join('\n'));
}

function printReview(summary: {
  outcome: string;
  attempt: number;
  attemptDirectory: string;
  findingCount: number;
  blockingFindingCount: number;
  visualSimilarityPercent: number | null;
  revisionGuidance: readonly string[];
  nextCommand: string;
  studioCommand: string;
}): void {
  const lines = [
    `Attempt ${summary.attempt}: ${summary.outcome}`,
    `Evidence:  ${summary.attemptDirectory}`,
    `Findings:  ${summary.findingCount} (${summary.blockingFindingCount} blocking)`,
    `Similarity: ${summary.visualSimilarityPercent === null ? 'not scored' : `${summary.visualSimilarityPercent.toFixed(3)}%`}`,
  ];
  if (summary.revisionGuidance.length > 0) {
    lines.push('', 'Revision guidance:', ...summary.revisionGuidance.map((item) => `  - ${item}`));
  }
  lines.push('', `Next: ${summary.nextCommand}`, `Studio: ${summary.studioCommand}`);
  console.log(lines.join('\n'));
}

function printImplementationPreparation(summary: {
  dryRun: boolean;
  taskId: string;
  taskFile: string;
  instructionsFile: string;
  writableFiles: readonly string[];
  route?: string;
  commands: { review: string; mcp: string };
}): void {
  console.log(
    [
      summary.dryRun
        ? 'Dry run: no task, queue, or artifact was created.'
        : `Prepared validate-UI task ${summary.taskId}.`,
      '',
      `Task contract: ${summary.taskFile}`,
      `Instructions:  ${summary.instructionsFile}`,
      `Review route:  ${summary.route ?? 'unavailable'}`,
      'Write only:',
      ...summary.writableFiles.map((path) => `  ${path}`),
      '',
      'Continue with an external agent or a human, then run:',
      `  ${summary.commands.review}`,
      '',
      'Or continue with a connected MCP agent:',
      `  ${summary.commands.mcp}`,
    ].join('\n'),
  );
}

function printImplementationReview(summary: {
  attempt: number;
  outcome: string;
  attemptDirectory: string;
  findingCount: number;
  blockingFindingCount: number;
  changedFiles: readonly string[];
  cells: readonly {
    viewport: string;
    state: string;
    classification: string;
    score: number | null;
  }[];
  nextCommand: string;
  studioCommand: string;
}): void {
  console.log(
    [
      `Attempt ${summary.attempt}: ${summary.outcome}`,
      `Evidence: ${summary.attemptDirectory}`,
      `Findings: ${summary.findingCount} (${summary.blockingFindingCount} blocking)`,
      `Changed allowlisted files: ${summary.changedFiles.join(', ') || 'none'}`,
      ...summary.cells.map(
        (cell) =>
          `${cell.viewport}/${cell.state}: ${cell.classification}, ${cell.score === null ? 'not scored' : `${cell.score.toFixed(3)}%`}`,
      ),
      '',
      `Next: ${summary.nextCommand}`,
      `Studio: ${summary.studioCommand}`,
    ].join('\n'),
  );
}

function absoluteTaskPath(path: string, invocationRoot: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(invocationRoot, path);
}

function parseAttempt(value: string): number {
  const attempt = Number(value);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new SmartUiError('INVALID_INPUT', 'An attempt must be a positive integer.');
  }
  return attempt;
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}
