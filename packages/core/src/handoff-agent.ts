import { readFile } from 'node:fs/promises';
import { SmartUiError } from './errors.js';
import { reviewGenerationTask } from './generation-handoff.js';
import { reviewImplementationTask } from './implementation-review.js';
import { projectHandoffTask } from './handoff-instructions.js';
import {
  hashBytes,
  listHandoffTasks,
  loadHandoffTask,
  resolveTaskPath,
  taskFilePath,
} from './handoff-store.js';

const MAX_EVIDENCE_PAGE_BYTES = 64_000;
const ACTIONABLE_STATUSES = new Set(['awaiting-author', 'revision-needed']);

/** Lists bounded, actionable handoff tasks under one caller-declared root. */
export async function listPendingHandoffTasks(
  root: string,
  taskType?: 'generation' | 'validate-ui',
) {
  const types = taskType ? [taskType] : (['generation', 'validate-ui'] as const);
  const loaded = (
    await Promise.all(types.map(async (type) => listHandoffTasks(root, type)))
  ).flat();
  return loaded
    .filter(({ state }) => ACTIONABLE_STATUSES.has(state.status))
    .sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt))
    .map(({ task, state }) => projectHandoffTask(task, state));
}

/** Loads one task through the strict task/state readers and returns its shared projection. */
export async function getHandoffTask(taskFile: string) {
  const loaded = await loadHandoffTask(taskFile);
  return projectHandoffTask(loaded.task, loaded.state);
}

/** Reads one text evidence item in deterministic byte pages without exposing arbitrary task files. */
export async function readHandoffEvidencePage(options: {
  taskFile: string;
  relativePath: string;
  offset?: number;
  limit?: number;
}) {
  const loaded = await loadHandoffTask(options.taskFile);
  const evidence = loaded.task.evidence.find((item) => item.relativePath === options.relativePath);
  if (!evidence) {
    throw new SmartUiError('NOT_FOUND', 'That path is not declared task evidence.');
  }
  if (!evidence.mediaType.startsWith('text/') && evidence.mediaType !== 'image/svg+xml') {
    throw new SmartUiError('POLICY_VIOLATION', 'Binary task evidence cannot be returned as text.');
  }
  const offset = options.offset ?? 0;
  const limit = options.limit ?? MAX_EVIDENCE_PAGE_BYTES;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new SmartUiError('INVALID_INPUT', 'Evidence offset must be a non-negative integer.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_PAGE_BYTES) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `Evidence limit must be an integer from 1 to ${MAX_EVIDENCE_PAGE_BYTES}.`,
    );
  }
  const path = await resolveTaskPath(loaded.taskRoot, evidence.relativePath, 'Task evidence');
  const bytes = await readFile(path);
  if (bytes.byteLength !== evidence.byteLength || hashBytes(bytes) !== evidence.hash) {
    throw new SmartUiError('POLICY_VIOLATION', 'Task evidence no longer matches its contract.');
  }
  const end = Math.min(bytes.byteLength, offset + limit);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end));
  } catch {
    throw new SmartUiError('INVALID_INPUT', 'Task evidence is not valid UTF-8 text.');
  }
  return {
    taskId: loaded.task.taskId,
    taskHash: loaded.task.taskHash,
    relativePath: evidence.relativePath,
    mediaType: evidence.mediaType,
    hash: evidence.hash,
    offset,
    nextOffset: end < bytes.byteLength ? end : null,
    totalBytes: bytes.byteLength,
    content,
  };
}

/** Submits MCP-authored generation files through the same immutable review path as the CLI. */
export async function submitHandoffGeneration(options: {
  taskFile: string;
  taskHash: string;
  revision: number;
  authoringAgent: string;
  files: readonly { relativePath: string; content: string }[];
  note?: string;
  signal?: AbortSignal;
}) {
  const loaded = await loadHandoffTask(options.taskFile);
  if (loaded.task.taskType !== 'generation') {
    throw new SmartUiError('INVALID_INPUT', 'This task is not a standalone generation task.');
  }
  if (loaded.task.taskHash !== options.taskHash || loaded.state.revision !== options.revision) {
    throw new SmartUiError(
      'TASK_BUSY',
      `Task state is revision ${loaded.state.revision}; re-read it before submitting.`,
    );
  }
  return reviewGenerationTask({
    taskFile: taskFilePath(loaded.taskRoot),
    author: options.authoringAgent,
    source: 'mcp',
    files: options.files,
    ...(options.note ? { note: options.note } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Applies exact MCP-authored source files and runs the shared immutable validate-UI review. */
export async function submitHandoffImplementation(options: {
  taskFile: string;
  taskHash: string;
  revision: number;
  authoringAgent: string;
  files: readonly { relativePath: string; content: string }[];
  note?: string;
  signal?: AbortSignal;
}) {
  const loaded = await loadHandoffTask(options.taskFile);
  if (loaded.task.taskType !== 'validate-ui') {
    throw new SmartUiError('INVALID_INPUT', 'This task is not a validate-UI task.');
  }
  if (loaded.task.taskHash !== options.taskHash || loaded.state.revision !== options.revision) {
    throw new SmartUiError(
      'TASK_BUSY',
      `Task state is revision ${loaded.state.revision}; re-read it before submitting.`,
    );
  }
  return reviewImplementationTask({
    taskFile: taskFilePath(loaded.taskRoot),
    author: options.authoringAgent,
    source: 'mcp',
    files: options.files,
    ...(options.note ? { note: options.note } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
