import { readHandoffAttemptResult, loadHandoffTask } from './handoff-store.js';
import { SmartUiError } from './errors.js';

/** Builds one compact review view without copying or trusting artifact paths outside the task. */
export async function taskReviewView(taskFile: string, requestedAttempt?: number) {
  const loaded = await loadHandoffTask(taskFile);
  const attempt = requestedAttempt ?? loaded.state.activeAttempt;
  const result = attempt ? await readHandoffAttemptResult(loaded.taskRoot, attempt) : undefined;
  if (requestedAttempt !== undefined && !result) {
    throw new SmartUiError('NOT_FOUND', `Attempt ${requestedAttempt} was not found.`);
  }
  return {
    schemaVersion: '1.0' as const,
    taskId: loaded.task.taskId,
    taskType: loaded.task.taskType,
    taskHash: loaded.task.taskHash,
    taskFile,
    status: loaded.state.status,
    revision: loaded.state.revision,
    activeAttempt: loaded.state.activeAttempt,
    acceptedAttempt: loaded.state.acceptedAttempt,
    writableFiles: loaded.task.writableFiles,
    route: loaded.task.taskType === 'validate-ui' ? loaded.task.route : null,
    attempt: result
      ? {
          number: result.attempt,
          outcome: result.outcome,
          findingCount: result.findingCount,
          blockingFindingCount: result.blockingFindingCount,
          warnings: result.warnings,
          failures: result.failures,
          revisionGuidance: result.revisionGuidance,
          generation: result.generation ?? null,
          implementation: result.implementation ?? null,
        }
      : null,
    commands: loaded.task.commands,
  };
}
