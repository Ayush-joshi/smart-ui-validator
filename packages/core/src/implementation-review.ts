import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { AutoFrameworkAdapter } from './auto-framework-adapter.js';
import { LocalArtifactStore } from './artifacts.js';
import { PlaywrightBrowserProvider } from './browser.js';
import { loadConfig, type Config } from './config.js';
import { SmartUiError } from './errors.js';
import { HeuristicRepairProvider } from './heuristic-repair.js';
import { viewportReferencePath } from './implementation-handoff.js';
import {
  handoffManifestHash,
  implementationReviewIndexSchema,
  type HandoffAttemptResult,
  type HandoffState,
  type HandoffSubmittedFile,
  type ImplementationReviewCell,
  type ImplementationReviewIndex,
  type ImplementationTask,
} from './handoff-contracts.js';
import {
  allocateHandoffAttempt,
  atomicWriteFile,
  hashBytes,
  loadHandoffTask,
  resolveTaskPath,
  updateHandoffState,
  withHandoffTaskLock,
  writeHandoffAttemptResult,
  writeHandoffSubmission,
} from './handoff-store.js';
import { LocalImageDesignProvider } from './local-image-provider.js';
import { MockCodingProvider } from './mock-coding-provider.js';
import { SmartUiOrchestrator } from './orchestrator.js';
import { LocalPolicy } from './policy.js';
import { HtmlReporter } from './reporter.js';
import { runRecordSchema, type RunRecord } from './schemas.js';

const MAX_SOURCE_BYTES = 20_000_000;

export interface ReviewImplementationTaskOptions {
  taskFile: string;
  author?: string;
  source?: 'cli' | 'mcp' | 'studio';
  note?: string;
  files?: readonly { relativePath: string; content: string }[];
  config?: Config;
  signal?: AbortSignal;
}

export interface ImplementationReviewOutcome {
  task: ImplementationTask;
  state: HandoffState;
  attempt: number;
  attemptRoot: string;
  result: HandoffAttemptResult;
  index: ImplementationReviewIndex;
}

/** Reviews one exact source snapshot without authoring, repairing, or rolling back completed work. */
export async function reviewImplementationTask(
  options: ReviewImplementationTaskOptions,
): Promise<ImplementationReviewOutcome> {
  const loaded = await loadHandoffTask(options.taskFile);
  if (loaded.task.taskType !== 'validate-ui') {
    throw new SmartUiError('INVALID_INPUT', 'This task is not a validate-UI task.');
  }
  if (loaded.state.status === 'accepted' || loaded.state.status === 'canceled') {
    throw new SmartUiError('POLICY_VIOLATION', `This task is ${loaded.state.status}.`);
  }
  const task = loaded.task;
  return withHandoffTaskLock(loaded.taskRoot, async () => {
    const config = options.config ?? (await loadConfig(task.root));
    const allocated = await allocateHandoffAttempt(loaded.taskRoot, loaded.state);
    let rollbackSupplied: (() => Promise<void>) | undefined;
    let snapshot: Awaited<ReturnType<typeof snapshotSources>>;
    let manifestHash: string;
    let state: HandoffState;
    try {
      if (options.files) rollbackSupplied = await applySuppliedFiles(task, options.files);
      snapshot = await snapshotSources(task, allocated.root);
      manifestHash = handoffManifestHash(snapshot.files);
      await writeHandoffSubmission(allocated.root, {
        schemaVersion: '1.0',
        taskId: task.taskId,
        taskType: task.taskType,
        taskHash: task.taskHash,
        attempt: allocated.attempt,
        submittedAt: new Date().toISOString(),
        author: options.author ?? 'external',
        source: options.source ?? 'cli',
        ...(options.note ? { note: options.note } : {}),
        files: snapshot.files,
        manifestHash,
      });
      state = await updateHandoffState(
        loaded.taskRoot,
        { taskHash: loaded.state.taskHash, revision: loaded.state.revision },
        (current) => ({
          ...current,
          status: 'reviewing',
          activeAttempt: allocated.attempt,
          attempts: [
            ...current.attempts,
            {
              attempt: allocated.attempt,
              createdAt: new Date().toISOString(),
              status: 'submitted',
              submissionHash: manifestHash,
              author: options.author ?? 'external',
              source: options.source ?? 'cli',
            },
          ],
        }),
      );
    } catch (error) {
      await rollbackSupplied?.();
      throw error;
    }
    const cells: ImplementationReviewIndex['cells'] = [];
    for (const [index, cell] of task.matrix.entries()) {
      cells.push(await reviewCell(task, allocated.root, cell, index, config, options.signal));
    }
    const reviewIndex = implementationReviewIndexSchema.parse({
      schemaVersion: '1.0',
      taskId: task.taskId,
      attempt: allocated.attempt,
      route: task.route,
      createdAt: new Date().toISOString(),
      cells,
    });
    const indexRelativePath = taskRelative(
      loaded.taskRoot,
      join(allocated.root, 'implementation-review-index.json'),
    );
    await atomicWriteFile(
      join(allocated.root, 'implementation-review-index.json'),
      `${JSON.stringify(reviewIndex, null, 2)}\n`,
      true,
    );
    const blockingFindingCount = cells.reduce(
      (total, cell) => total + cell.blockingFindingCount,
      0,
    );
    const failures = cells
      .filter((cell) => cell.status === 'failed')
      .map((cell) => ({
        code: 'REVIEW_CELL_FAILED',
        message: `${cell.viewport}/${cell.state} did not complete successfully.`,
      }));
    const outcome = failures.length > 0 || blockingFindingCount > 0 ? 'failed' : 'passed';
    const result: HandoffAttemptResult = {
      schemaVersion: '1.0',
      taskId: task.taskId,
      taskType: task.taskType,
      taskHash: task.taskHash,
      attempt: allocated.attempt,
      reviewedAt: new Date().toISOString(),
      outcome,
      findingCount: cells.reduce((total, cell) => total + cell.findingCount, 0),
      blockingFindingCount,
      warnings: [],
      failures,
      revisionGuidance:
        outcome === 'passed'
          ? []
          : [
              'Review the ordered cell evidence, revise only the allowlisted files, and submit a new attempt.',
            ],
      implementation: {
        route: task.route,
        changedFiles: snapshot.changedFiles,
        indexPath: indexRelativePath,
        cells,
      },
    };
    await writeHandoffAttemptResult(allocated.root, result);
    state = await updateHandoffState(
      loaded.taskRoot,
      { taskHash: state.taskHash, revision: state.revision },
      (current) => ({
        ...current,
        status: outcome === 'passed' ? 'awaiting-decision' : 'revision-needed',
        attempts: current.attempts.map((item) =>
          item.attempt === allocated.attempt
            ? {
                ...item,
                status: 'reviewed' as const,
                outcome,
                findingCount: result.findingCount,
                visualSimilarityPercent:
                  cells.find((cell) => cell.classification === 'source-fidelity')?.score ?? null,
              }
            : item,
        ),
      }),
    );
    return {
      task,
      state,
      attempt: allocated.attempt,
      attemptRoot: allocated.root,
      result,
      index: reviewIndex,
    };
  });
}

async function reviewCell(
  task: ImplementationTask,
  attemptRoot: string,
  cell: ImplementationReviewCell,
  index: number,
  config: Config,
  signal: AbortSignal | undefined,
) {
  const cellName = `${String(index + 1).padStart(3, '0')}-${safeName(cell.viewport.name)}-${cell.state}`;
  const artifactRoot = join(attemptRoot, 'artifacts', cellName);
  const store = new LocalArtifactStore(artifactRoot);
  const recordPath = join(attemptRoot, 'artifacts', 'records', `${cellName}.json`);
  await mkdir(resolve(recordPath, '..'), { recursive: true, mode: 0o700 });
  let record: RunRecord;
  if (cell.classification === 'responsive-robustness') {
    record = await captureRobustness(task, cell, store, config, signal);
  } else {
    const designEvidence =
      cell.classification === 'alternate-reference-fidelity'
        ? task.evidence.find(
            (item) =>
              item.role === 'viewport-reference' &&
              item.relativePath === viewportReferencePath(cell.viewport.name, item.mediaType),
          )
        : task.evidence.find((item) =>
            task.design.mediaType === 'image/png'
              ? item.role === 'design-reference'
              : item.role === 'sanitized-design',
          );
    if (!designEvidence) throw new SmartUiError('NOT_FOUND', 'Pinned design evidence is missing.');
    const designPath = await resolveTaskPath(
      task.taskRoot,
      designEvidence.relativePath,
      'Design evidence',
    );
    const contract = await new LocalImageDesignProvider(store).normalize({
      imagePath: designPath,
      name: task.design.filename,
      spec: {
        route: new URL(cell.url ?? task.route).pathname,
        viewport: cell.viewport,
        theme: task.rendering.theme,
        locale: task.rendering.locale,
        ambiguities: task.uncertainties,
      },
    });
    const policy = new LocalPolicy({
      targetRoot: task.root,
      writableFiles: task.writableFiles,
      allowedEndpoints: task.endpointPolicy,
      dryRun: false,
      maxExecutionTimeMs: config.generation.timeoutMs,
    });
    record = (
      await new SmartUiOrchestrator({
        framework: new AutoFrameworkAdapter(),
        coding: new MockCodingProvider(),
        repair: new HeuristicRepairProvider(),
        browser: new PlaywrightBrowserProvider(),
        artifacts: store,
        policy,
        reporter: new HtmlReporter(store),
      }).run({
        targetRoot: task.root,
        designContractPath: task.designContractPath,
        contract,
        url: cell.url ?? task.route,
        repairEnabled: false,
        interaction: {
          name: cell.state,
          ...(cell.selector ? { selector: cell.selector } : {}),
        },
        ...(signal ? { signal } : {}),
      })
    ).record;
  }
  await atomicWriteFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, true);
  const finalPass = record.passes.at(-1);
  const findings = finalPass?.findings ?? [];
  return {
    viewport: cell.viewport.name,
    state: cell.state,
    classification: cell.classification,
    runRecordPath: taskRelative(task.taskRoot, recordPath),
    score: cell.classification === 'responsive-robustness' ? null : (record.score ?? null),
    visualMismatchPercent:
      cell.classification === 'responsive-robustness' ? null : (finalPass?.diffPercent ?? null),
    findingCount: findings.length + record.failures.length,
    blockingFindingCount:
      findings.filter((finding) => finding.severity === 'error').length + record.failures.length,
    status: record.status,
  } as const;
}

async function captureRobustness(
  task: ImplementationTask,
  cell: ImplementationReviewCell,
  store: LocalArtifactStore,
  config: Config,
  signal: AbortSignal | undefined,
): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const id = randomUUID();
  try {
    const evidence = await new PlaywrightBrowserProvider().capture({
      url: cell.url ?? task.route,
      viewport: cell.viewport,
      timeoutMs: config.generation.timeoutMs,
      locale: task.rendering.locale,
      theme: task.rendering.theme,
      allowedEndpoints: task.endpointPolicy,
      blockExternalNetwork: config.policy.blockExternalNetwork,
      interaction: { name: cell.state, ...(cell.selector ? { selector: cell.selector } : {}) },
      dynamicRegionSelectors: config.dynamicRegions.map((region) => region.selector),
      ...(signal ? { signal } : {}),
      evidenceLimits: config.evidence,
    });
    const screenshot = await store.put(evidence.screenshot, 'image/png', `${id}-robustness.png`);
    const failures = [
      ...evidence.consoleErrors.map((message) => ({
        code: 'CONSOLE_ERROR',
        message,
        recoverable: true,
      })),
      ...evidence.failedRequests.map((message) => ({
        code: 'NETWORK_FAILURE',
        message,
        recoverable: true,
      })),
      ...(evidence.accessibilityViolations ?? []).map((item) => ({
        code: 'ACCESSIBILITY',
        message: item.message,
        recoverable: true,
      })),
    ];
    return runRecordSchema.parse({
      schemaVersion: '1.0',
      id,
      status: failures.length > 0 ? 'failed' : 'succeeded',
      startedAt,
      completedAt: new Date().toISOString(),
      targetRoot: task.root,
      designContract: task.designContractPath,
      inputs: {
        url: cell.url ?? task.route,
        viewport: cell.viewport.name,
        state: cell.state,
        classification: cell.classification,
      },
      decisions: [
        {
          kind: 'evidence-classification',
          message: 'Robustness-only capture; no visual fidelity score was calculated.',
        },
      ],
      targetArtifact: screenshot,
      artifacts: [screenshot],
      changedFiles: [],
      timingsMs: {},
      warnings: [],
      failures,
      passes: [],
      stoppedReason: failures.length > 0 ? 'provider-failure' : 'validation-only',
      provenance: { tool: 'smart-ui', version: '0.4.2' },
    });
  } catch (error) {
    const placeholder = await store.put(
      new Uint8Array(),
      'application/octet-stream',
      `${id}-failed.bin`,
    );
    return runRecordSchema.parse({
      schemaVersion: '1.0',
      id,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      targetRoot: task.root,
      designContract: task.designContractPath,
      inputs: {
        url: cell.url ?? task.route,
        viewport: cell.viewport.name,
        state: cell.state,
        classification: cell.classification,
      },
      decisions: [
        {
          kind: 'evidence-classification',
          message: 'Robustness-only capture; no visual fidelity score was calculated.',
        },
      ],
      targetArtifact: placeholder,
      artifacts: [placeholder],
      changedFiles: [],
      timingsMs: {},
      warnings: [],
      failures: [
        {
          code: error instanceof SmartUiError ? error.code : 'PROVIDER_FAILURE',
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
      ],
      passes: [],
      stoppedReason: 'provider-failure',
      provenance: { tool: 'smart-ui', version: '0.4.2' },
    });
  }
}

async function snapshotSources(task: ImplementationTask, attemptRoot: string) {
  const files: HandoffSubmittedFile[] = [];
  const changedFiles: string[] = [];
  const policy = new LocalPolicy({ targetRoot: task.root, writableFiles: task.writableFiles });
  for (const baseline of task.baselines) {
    policy.assertReadable(baseline.relativePath);
    const path = resolve(task.root, baseline.relativePath);
    const info = await lstat(path).catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!info || !info.isFile() || info.isSymbolicLink()) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        `${baseline.relativePath} must exist as a regular UTF-8 file for review.`,
      );
    }
    if (info.size > MAX_SOURCE_BYTES)
      throw new SmartUiError(
        'POLICY_VIOLATION',
        `${baseline.relativePath} exceeds the source-file byte limit.`,
      );
    const bytes = await readFile(path);
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const destination = join(attemptRoot, 'submitted', baseline.relativePath);
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    const hash = hashBytes(bytes);
    files.push({
      relativePath: baseline.relativePath,
      mediaType: sourceMediaType(baseline.relativePath),
      hash,
      byteLength: bytes.byteLength,
    });
    if (!baseline.existed || baseline.hash !== hash) changedFiles.push(baseline.relativePath);
    if (baseline.existed) {
      const before = await resolveTaskPath(
        task.taskRoot,
        `repository/baseline/${baseline.relativePath}`,
        'Source baseline',
      );
      const beforeBytes = await readFile(before);
      if (
        hashBytes(beforeBytes) !== baseline.hash ||
        beforeBytes.byteLength !== baseline.byteLength
      ) {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          `${baseline.relativePath} baseline evidence no longer matches the task contract.`,
        );
      }
      const beforeDestination = join(attemptRoot, 'before', baseline.relativePath);
      await mkdir(resolve(beforeDestination, '..'), { recursive: true, mode: 0o700 });
      await writeFile(beforeDestination, beforeBytes, { flag: 'wx', mode: 0o600 });
    }
  }
  return { files, changedFiles };
}

async function applySuppliedFiles(
  task: ImplementationTask,
  supplied: readonly { relativePath: string; content: string }[],
): Promise<() => Promise<void>> {
  const expected = [...task.writableFiles].sort();
  const received = supplied.map((file) => file.relativePath).sort();
  if (
    new Set(received).size !== received.length ||
    JSON.stringify(expected) !== JSON.stringify(received)
  ) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      'MCP submission must include every exact writable file once.',
    );
  }
  const rollback = new Map<string, Uint8Array | undefined>();
  const policy = new LocalPolicy({ targetRoot: task.root, writableFiles: task.writableFiles });
  for (const file of supplied) policy.assertWritable(file.relativePath);
  const restore = async () => {
    for (const [path, bytes] of rollback) {
      if (bytes) await writeFile(path, bytes);
      else await rm(path, { force: true });
    }
  };
  try {
    for (const file of supplied) {
      const bytes = new TextEncoder().encode(file.content);
      if (bytes.byteLength > MAX_SOURCE_BYTES)
        throw new SmartUiError(
          'POLICY_VIOLATION',
          `${file.relativePath} exceeds the source-file byte limit.`,
        );
      const destination = resolve(task.root, file.relativePath);
      rollback.set(
        destination,
        await readFile(destination).catch((error) =>
          isMissing(error) ? undefined : Promise.reject(error),
        ),
      );
      await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    }
  } catch (error) {
    await restore();
    throw error;
  }
  return restore;
}

function taskRelative(taskRoot: string, path: string): string {
  return relative(taskRoot, path).split(sep).join('/');
}

function sourceMediaType(path: string): string {
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.json')) return 'application/json';
  return 'text/plain';
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'cell';
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
