import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SmartUiError } from './errors.js';
import {
  computeHandoffTaskHash,
  handoffStateSchema,
  handoffSubmissionSchema,
  handoffAttemptResultSchema,
  handoffTaskSchema,
  HANDOFF_TASK_ID,
  MAX_HANDOFF_ATTEMPTS,
  type HandoffAttemptResult,
  type HandoffState,
  type HandoffStatus,
  type HandoffSubmission,
  type HandoffTask,
  type HandoffTaskType,
} from './handoff-contracts.js';

/**
 * Atomic, single-writer task storage. Every mutation is written to a temporary path and renamed, and
 * every state replacement compares the expected task hash and revision first. Competing CLI, Studio,
 * and MCP work fails closed with TASK_BUSY instead of waiting or corrupting an attempt.
 */

export const TASK_FILE = 'task.json';
export const STATE_FILE = 'state.json';
export const INSTRUCTIONS_FILE = 'AGENT_INSTRUCTIONS.md';
export const EVIDENCE_DIRNAME = 'evidence';
export const PROPOSAL_DIRNAME = 'proposal';
export const REPOSITORY_DIRNAME = 'repository';
export const REVIEWS_DIRNAME = 'reviews';
const LOCK_FILE = '.task-lock';
const ATTEMPT_DIRECTORY = /^attempt-(\d{4})$/u;
/** A lock older than this is a crashed process, not a competing writer. */
const STALE_LOCK_MS = 15 * 60 * 1_000;

export function handoffTasksRoot(root: string, taskType: HandoffTaskType): string {
  return join(
    resolve(root),
    '.smart-ui',
    taskType === 'generation' ? 'generation-tasks' : 'validate-ui-tasks',
  );
}

export function handoffTaskRoot(root: string, taskType: HandoffTaskType, taskId: string): string {
  assertTaskId(taskId);
  return join(handoffTasksRoot(root, taskType), taskId);
}

export function taskFilePath(taskRoot: string): string {
  return join(taskRoot, TASK_FILE);
}

export function attemptRoot(taskRoot: string, attempt: number): string {
  return join(taskRoot, REVIEWS_DIRNAME, attemptDirectoryName(attempt));
}

export function attemptDirectoryName(attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_HANDOFF_ATTEMPTS) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `An attempt must be an integer from 1 to ${MAX_HANDOFF_ATTEMPTS}.`,
    );
  }
  return `attempt-${String(attempt).padStart(4, '0')}`;
}

export interface LoadedHandoffTask {
  task: HandoffTask;
  taskRoot: string;
  state: HandoffState;
}

/** Creates the immutable task contract and its first state. Fails if the task already exists. */
export async function createHandoffTask(
  task: Omit<HandoffTask, 'taskHash'> & { taskHash?: string },
): Promise<LoadedHandoffTask> {
  const { taskHash, ...body } = task;
  void taskHash;
  const validated = handoffTaskSchema.parse({ ...body, taskHash: computeHandoffTaskHash(body) });
  const taskRoot = resolve(validated.taskRoot);
  await mkdir(join(taskRoot, REVIEWS_DIRNAME), { recursive: true, mode: 0o700 });
  await atomicWriteJson(taskFilePath(taskRoot), validated, true);
  const state = handoffStateSchema.parse({
    schemaVersion: '1.0',
    taskId: validated.taskId,
    taskType: validated.taskType,
    taskHash: validated.taskHash,
    revision: 0,
    status: 'awaiting-author',
    updatedAt: validated.createdAt,
    activeAttempt: null,
    acceptedAttempt: null,
    attempts: [],
  });
  await atomicWriteJson(join(taskRoot, STATE_FILE), state, true);
  return { task: validated, taskRoot, state };
}

/** Reads and re-verifies a task and its state from a `task.json` path supplied by a caller. */
export async function loadHandoffTask(taskJsonPath: string): Promise<LoadedHandoffTask> {
  const path = resolve(taskJsonPath);
  if (!path.endsWith(`${sep}${TASK_FILE}`)) {
    throw new SmartUiError('INVALID_INPUT', `A task path must point at ${TASK_FILE}.`);
  }
  const taskRoot = resolve(path, '..');
  await assertRealDirectory(taskRoot, 'Task directory');
  const task = handoffTaskSchema.parse(await readJson(path, 'task'));
  const { taskHash, ...body } = task;
  if (computeHandoffTaskHash(body) !== taskHash) {
    throw new SmartUiError('POLICY_VIOLATION', 'Task contract failed its recorded hash check.');
  }
  if (!(await sameDirectory(task.taskRoot, taskRoot))) {
    throw new SmartUiError('POLICY_VIOLATION', 'Task contract was moved from its declared root.');
  }
  const state = await readHandoffState(taskRoot);
  if (state.taskId !== task.taskId || state.taskHash !== task.taskHash) {
    throw new SmartUiError('POLICY_VIOLATION', 'Task state does not belong to this task contract.');
  }
  return { task, taskRoot, state };
}

export async function readHandoffState(taskRoot: string): Promise<HandoffState> {
  return handoffStateSchema.parse(
    await readJson(join(resolve(taskRoot), STATE_FILE), 'task state'),
  );
}

/**
 * Replaces the mutable state after comparing the expected task hash and revision. The caller's
 * mutation receives the verified current state and returns the next status-bearing fields.
 */
export async function updateHandoffState(
  taskRoot: string,
  expected: { taskHash: string; revision: number },
  mutate: (current: HandoffState) => Omit<HandoffState, 'revision' | 'updatedAt'>,
): Promise<HandoffState> {
  const root = resolve(taskRoot);
  const current = await readHandoffState(root);
  if (current.taskHash !== expected.taskHash) {
    throw new SmartUiError('POLICY_VIOLATION', 'Task state hash no longer matches this task.');
  }
  if (current.revision !== expected.revision) {
    throw new SmartUiError(
      'TASK_BUSY',
      `Task state moved to revision ${current.revision}; re-read the task before writing.`,
    );
  }
  const next = handoffStateSchema.parse({
    ...mutate(current),
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  await atomicWriteJson(join(root, STATE_FILE), next, false);
  return next;
}

/** Convenience wrapper for a simple status transition. */
export async function setHandoffStatus(
  taskRoot: string,
  state: HandoffState,
  status: HandoffStatus,
  patch: Partial<Omit<HandoffState, 'revision' | 'updatedAt'>> = {},
): Promise<HandoffState> {
  return updateHandoffState(
    taskRoot,
    { taskHash: state.taskHash, revision: state.revision },
    (current) => ({ ...current, ...patch, status }),
  );
}

/**
 * Records an explicit human decision. Acceptance changes task metadata only: it never commits,
 * pushes, deploys, publishes, or rewrites any reviewed file.
 */
export async function acceptHandoffAttempt(
  taskRoot: string,
  state: HandoffState,
  attempt: number,
): Promise<HandoffState> {
  if (state.status === 'accepted') {
    throw new SmartUiError('POLICY_VIOLATION', 'This task was already accepted.');
  }
  if (state.status === 'canceled') {
    throw new SmartUiError('POLICY_VIOLATION', 'A canceled task cannot be accepted.');
  }
  const reference = state.attempts.find((item) => item.attempt === attempt);
  if (!reference) {
    throw new SmartUiError('NOT_FOUND', `Attempt ${attempt} does not exist on this task.`);
  }
  if (reference.status !== 'reviewed' || reference.outcome !== 'passed') {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `Attempt ${attempt} did not pass its deterministic review, so it cannot be accepted.`,
    );
  }
  return setHandoffStatus(taskRoot, state, 'accepted', {
    acceptedAttempt: attempt,
    activeAttempt: attempt,
  });
}

export async function cancelHandoffTask(
  taskRoot: string,
  state: HandoffState,
): Promise<HandoffState> {
  if (state.status === 'accepted') {
    throw new SmartUiError('POLICY_VIOLATION', 'An accepted task cannot be canceled.');
  }
  if (state.status === 'canceled') return state;
  return setHandoffStatus(taskRoot, state, 'canceled');
}

/** Runs one bounded mutation while this process exclusively owns the task. */
export async function withHandoffTaskLock<T>(
  taskRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = join(resolve(taskRoot), LOCK_FILE);
  const owner = `${process.pid}:${randomUUID()}`;
  await acquire(path, owner);
  try {
    return await operation();
  } finally {
    await releaseIfOwned(path, owner);
  }
}

async function acquire(path: string, owner: string): Promise<void> {
  const marker = `${JSON.stringify({ owner, acquiredAt: new Date().toISOString() })}\n`;
  try {
    await writeFile(path, marker, { flag: 'wx', mode: 0o600 });
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const existing = await readOptional(path);
  const acquiredAt = existing ? parseLockTime(existing) : undefined;
  if (acquiredAt === undefined || Date.now() - acquiredAt < STALE_LOCK_MS) {
    throw new SmartUiError(
      'TASK_BUSY',
      'Another Smart UI process owns this task. Retry after it finishes, or cancel the task.',
    );
  }
  // Only a verifiably stale marker is cleared, and the replacement still races exclusively.
  await rm(path, { force: true });
  try {
    await writeFile(path, marker, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    throw new SmartUiError('TASK_BUSY', 'Another Smart UI process claimed this task first.');
  }
}

async function releaseIfOwned(path: string, owner: string): Promise<void> {
  const existing = await readOptional(path);
  if (existing && !existing.includes(owner)) return;
  await rm(path, { force: true });
}

function parseLockTime(raw: string): number | undefined {
  try {
    const value = JSON.parse(raw) as { acquiredAt?: unknown };
    const parsed = typeof value.acquiredAt === 'string' ? Date.parse(value.acquiredAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Allocates the next attempt directory. Incomplete or malformed earlier attempts are quarantined so
 * a partially written review is never exposed as evidence.
 */
export async function allocateHandoffAttempt(
  taskRoot: string,
  state: HandoffState,
): Promise<{ attempt: number; root: string }> {
  const reviews = join(resolve(taskRoot), REVIEWS_DIRNAME);
  await mkdir(reviews, { recursive: true, mode: 0o700 });
  const onDisk: number[] = [];
  for (const entry of await readdir(reviews, { withFileTypes: true })) {
    const match = ATTEMPT_DIRECTORY.exec(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !match) continue;
    const number = Number(match[1]);
    onDisk.push(number);
    const recorded = state.attempts.some((item) => item.attempt === number);
    const complete = await exists(join(reviews, entry.name, 'submission.json'));
    if (!recorded || !complete) {
      await rename(
        join(reviews, entry.name),
        join(reviews, `${entry.name}.quarantined-${randomUUID()}`),
      );
    }
  }
  const attempt = Math.max(0, ...onDisk, ...state.attempts.map((item) => item.attempt)) + 1;
  if (attempt > MAX_HANDOFF_ATTEMPTS) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `This task reached its bound of ${MAX_HANDOFF_ATTEMPTS} attempts; accept an attempt or start a new task.`,
    );
  }
  const root = attemptRoot(taskRoot, attempt);
  await mkdir(join(root, 'submitted'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'artifacts'), { recursive: true, mode: 0o700 });
  return { attempt, root };
}

export async function writeHandoffSubmission(
  attemptDirectory: string,
  submission: HandoffSubmission,
): Promise<void> {
  await atomicWriteJson(
    join(resolve(attemptDirectory), 'submission.json'),
    handoffSubmissionSchema.parse(submission),
    true,
  );
}

export async function writeHandoffAttemptResult(
  attemptDirectory: string,
  result: HandoffAttemptResult,
): Promise<void> {
  await atomicWriteJson(
    join(resolve(attemptDirectory), 'result.json'),
    handoffAttemptResultSchema.parse(result),
    true,
  );
}

export async function readHandoffAttemptResult(
  taskRoot: string,
  attempt: number,
): Promise<HandoffAttemptResult | undefined> {
  const raw = await readOptional(join(attemptRoot(taskRoot, attempt), 'result.json'));
  if (raw === undefined) return undefined;
  return handoffAttemptResultSchema.parse(JSON.parse(raw));
}

export async function readHandoffSubmission(
  taskRoot: string,
  attempt: number,
): Promise<HandoffSubmission | undefined> {
  const raw = await readOptional(join(attemptRoot(taskRoot, attempt), 'submission.json'));
  if (raw === undefined) return undefined;
  return handoffSubmissionSchema.parse(JSON.parse(raw));
}

/** Lists every readable task of one type inside a declared root. Malformed tasks are skipped. */
export async function listHandoffTasks(
  root: string,
  taskType: HandoffTaskType,
): Promise<LoadedHandoffTask[]> {
  const tasksRoot = handoffTasksRoot(root, taskType);
  const loaded: LoadedHandoffTask[] = [];
  for (const entry of (await listEntries(tasksRoot)).sort()) {
    if (!HANDOFF_TASK_ID.test(entry)) continue;
    try {
      loaded.push(await loadHandoffTask(join(tasksRoot, entry, TASK_FILE)));
    } catch {
      // A malformed or partially written task is never exposed as pending work.
    }
  }
  return loaded;
}

/** Resolves one task-relative path, rejecting traversal and links inside the task directory. */
export async function resolveTaskPath(
  taskRoot: string,
  relativePath: string,
  label: string,
): Promise<string> {
  const root = resolve(taskRoot);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new SmartUiError('POLICY_VIOLATION', `${label} escapes the task directory.`);
  }
  let current = root;
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new SmartUiError('POLICY_VIOLATION', `${label} crosses a symbolic link.`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return candidate;
}

export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function atomicWriteJson(
  destination: string,
  value: unknown,
  exclusive: boolean,
): Promise<void> {
  await atomicWriteFile(destination, `${JSON.stringify(value, null, 2)}\n`, exclusive);
}

export async function atomicWriteFile(
  destination: string,
  contents: string | Uint8Array,
  exclusive: boolean,
): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    if (exclusive && (await exists(destination))) {
      throw new SmartUiError('POLICY_VIOLATION', `Refusing to overwrite ${destination}.`);
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJson(path: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new SmartUiError('NOT_FOUND', `The ${label} file was not found.`);
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SmartUiError('INVALID_INPUT', `The ${label} file is not valid JSON.`);
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function listEntries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw new SmartUiError('NOT_FOUND', `${label} does not exist.`);
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SmartUiError('POLICY_VIOLATION', `${label} must be a real directory.`);
  }
}

function assertTaskId(taskId: string): void {
  if (!HANDOFF_TASK_ID.test(taskId)) {
    throw new SmartUiError('INVALID_INPUT', 'A task identifier is required.');
  }
}

/** Compares real paths so short names, case, and links cannot forge or reject a legitimate task. */
async function sameDirectory(declared: string, actual: string): Promise<boolean> {
  if (resolve(declared) === actual) return true;
  try {
    return (await realpath(resolve(declared))) === (await realpath(actual));
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
