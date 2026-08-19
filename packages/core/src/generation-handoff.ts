import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { LocalArtifactStore } from './artifacts.js';
import { PlaywrightBrowserProvider } from './browser.js';
import { loadConfig, type Config } from './config.js';
import { SmartUiError } from './errors.js';
import {
  emptyStructuredDesignContext,
  hashStructuredContext,
  intrinsicPresentationSpec,
  presentationSpecSchema,
  svgGenerationInputSchema,
  type GenerationLayout,
  type GenerationMode,
  type GenerationRecord,
  type PresentationSpec,
  type StructuredDesignContext,
} from './generation-contracts.js';
import { ReproducibleGenerationExporter } from './generation-exporter.js';
import { GenerationOrchestrator, type GenerationResult } from './generation-orchestrator.js';
import { LoopbackGeneratedPreviewProvider } from './generation-preview.js';
import { HtmlGenerationReporter } from './generation-reporter.js';
import { DeterministicHtmlGenerationProvider } from './html-generation-provider.js';
import {
  HostProposedHtmlGenerationProvider,
  type HostProposedGenerationFile,
} from './host-proposed-generation.js';
import {
  handoffManifestHash,
  MAX_HANDOFF_SUBMISSION_BYTES,
  type GenerationTask,
  type HandoffAttemptResult,
  type HandoffEvidence,
  type HandoffState,
  type HandoffSubmittedFile,
} from './handoff-contracts.js';
import { renderAgentInstructions } from './handoff-instructions.js';
import {
  prepareDesignContextFile,
  prepareDesignInput,
  readPresentationSpecFile,
  readStructuredContextFile,
} from './handoff-intake.js';
import {
  allocateHandoffAttempt,
  atomicWriteFile,
  handoffTaskRoot,
  hashBytes,
  INSTRUCTIONS_FILE,
  loadHandoffTask,
  PROPOSAL_DIRNAME,
  resolveTaskPath,
  taskFilePath,
  updateHandoffState,
  withHandoffTaskLock,
  writeHandoffAttemptResult,
  writeHandoffSubmission,
  createHandoffTask,
  EVIDENCE_DIRNAME,
} from './handoff-store.js';
import { LocalSvgStructureProvider } from './svg-generation-provider.js';

/**
 * Standalone generation handoff. Prepare records verified evidence and an exact proposal manifest;
 * review re-runs the same deterministic comparison the one-shot CLI uses. Neither step invokes a
 * model, waits for an agent, or lets authored content widen policy.
 */

const PROPOSAL_ENTRY = 'index.html';
const PROPOSAL_STYLESHEET = 'styles.css';
const PROPOSAL_ASSETS = 'assets';
const MAX_PROPOSAL_FILES = 40;
const MAX_PROPOSAL_FILE_BYTES = 4_000_000;

export interface PrepareGenerationTaskOptions {
  workspace: string;
  designPath: string;
  designContextPath?: string;
  structuredContextPath?: string;
  presentationPath?: string;
  mode: GenerationMode;
  layout: GenerationLayout;
  name?: string;
  instructions?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  dryRun?: boolean;
  studioRunId?: string;
  config?: Config;
  signal?: AbortSignal;
}

export interface GenerationTaskPreparation {
  dryRun: boolean;
  task: GenerationTask;
  state: HandoffState;
  taskRoot: string;
  taskFile: string;
  instructionsFile: string;
  proposalDirectory: string;
}

/** Inspects the design, copies verified evidence, and writes the immutable generation task. */
export async function prepareGenerationTask(
  options: PrepareGenerationTaskOptions,
): Promise<GenerationTaskPreparation> {
  // Canonicalized once so every later containment check compares one stable spelling of the root.
  const workspace = await realpath(resolve(options.workspace));
  const config = options.config ?? (await loadConfig(workspace));
  const design = await prepareDesignInput(
    workspace,
    await realpath(resolve(options.designPath)),
    config.generation.limits,
  );

  let structuredDesignContext: StructuredDesignContext | undefined;
  let contextEvidence: HandoffEvidence | undefined;
  let contextBytes: Uint8Array | undefined;
  if (options.structuredContextPath) {
    structuredDesignContext = await readStructuredContextFile(
      workspace,
      options.structuredContextPath,
    );
  }
  if (options.designContextPath) {
    const context = await prepareDesignContextFile(
      workspace,
      options.designContextPath,
      'cli:user-supplied',
    );
    if ('structuredDesignContext' in context) {
      structuredDesignContext ??= context.structuredDesignContext;
    } else {
      contextBytes = new TextEncoder().encode(context.designContext.content);
      contextEvidence = {
        role: 'design-context',
        relativePath: `${EVIDENCE_DIRNAME}/context-${safeName(context.designContext.filename)}`,
        filename: context.designContext.filename,
        mediaType: context.designContext.mediaType,
        byteLength: contextBytes.byteLength,
        hash: hashBytes(contextBytes),
        originalHash: context.designContext.originalHash,
        redacted: context.designContext.contentRedacted,
        provenance: context.designContext.provenance,
      };
    }
  }
  const presentationInput = options.presentationPath
    ? await readPresentationSpecFile(workspace, options.presentationPath)
    : undefined;

  const inspection = await inspectForHandoff(workspace, design, options, presentationInput);
  const presentationSpec = presentationInput ?? intrinsicPresentationSpec(inspection.viewport);
  const context = structuredDesignContext ?? emptyStructuredDesignContext(options.instructions);

  const taskId = `task-${randomUUID()}`;
  const taskRoot = handoffTaskRoot(workspace, 'generation', taskId);
  const normalizedDesignPath =
    design.mediaType === 'image/png'
      ? `${EVIDENCE_DIRNAME}/normalized-design.svg`
      : `${EVIDENCE_DIRNAME}/${safeName(design.filename)}`;
  const designEvidencePath = `${EVIDENCE_DIRNAME}/${safeName(design.filename)}`;

  const evidence: HandoffEvidence[] = [
    {
      role: design.mediaType === 'image/png' ? 'design-reference' : 'sanitized-design',
      relativePath: designEvidencePath,
      filename: design.filename,
      mediaType: design.mediaType,
      byteLength: design.byteLength,
      hash: design.originalHash,
      originalHash: design.originalHash,
      redacted: false,
      provenance: 'user-supplied',
    },
    ...(contextEvidence ? [contextEvidence] : []),
  ];

  const body = {
    schemaVersion: '1.0' as const,
    taskType: 'generation' as const,
    taskId,
    createdAt: new Date().toISOString(),
    root: workspace,
    taskRoot,
    design: {
      filename: design.filename,
      mediaType: design.mediaType,
      byteLength: design.byteLength,
      originalHash: design.originalHash,
      sanitizedHash: inspection.sanitizedHash,
      width: inspection.viewport.width,
      height: inspection.viewport.height,
    },
    evidence,
    structuredDesignContext: context,
    structuredContextHash: hashStructuredContext(context),
    presentationSpec,
    presentationHash: hashPresentation(presentationSpec),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    rendering: { locale: 'en-US', theme: 'light' as const, background: 'transparent' },
    decisions: inspection.decisions,
    uncertainties: inspection.uncertainties,
    writableFiles: [
      `${PROPOSAL_DIRNAME}/${PROPOSAL_ENTRY}`,
      `${PROPOSAL_DIRNAME}/${PROPOSAL_STYLESHEET}`,
    ],
    commands: generationCommands(taskRoot),
    ...(options.studioRunId ? { studioRunId: options.studioRunId } : {}),
    mode: options.mode,
    layout: options.layout,
    proposalDirectory: PROPOSAL_DIRNAME,
    normalizedDesignPath,
  };

  if (options.dryRun) {
    const preview = { ...body, taskHash: 'sha256:'.padEnd(71, '0') } as GenerationTask;
    return {
      dryRun: true,
      task: preview,
      state: previewState(preview),
      taskRoot,
      taskFile: taskFilePath(taskRoot),
      instructionsFile: join(taskRoot, INSTRUCTIONS_FILE),
      proposalDirectory: join(taskRoot, PROPOSAL_DIRNAME),
    };
  }

  const created = await createHandoffTask(body);
  const task = created.task as GenerationTask;
  await mkdir(join(taskRoot, EVIDENCE_DIRNAME), { recursive: true, mode: 0o700 });
  await mkdir(join(taskRoot, PROPOSAL_DIRNAME), { recursive: true, mode: 0o700 });
  await copyFile(
    design.originalPath,
    await resolveTaskPath(taskRoot, designEvidencePath, 'Design evidence'),
  );
  if (design.normalizedSvg) {
    await atomicWriteFile(
      await resolveTaskPath(taskRoot, normalizedDesignPath, 'Normalized design'),
      design.normalizedSvg,
      true,
    );
  }
  if (contextEvidence && contextBytes) {
    await atomicWriteFile(
      await resolveTaskPath(taskRoot, contextEvidence.relativePath, 'Design context evidence'),
      contextBytes,
      true,
    );
  }
  await atomicWriteFile(
    join(taskRoot, INSTRUCTIONS_FILE),
    renderAgentInstructions(task, created.state),
    true,
  );
  return {
    dryRun: false,
    task,
    state: created.state,
    taskRoot,
    taskFile: taskFilePath(taskRoot),
    instructionsFile: join(taskRoot, INSTRUCTIONS_FILE),
    proposalDirectory: join(taskRoot, PROPOSAL_DIRNAME),
  };
}

export interface ReviewGenerationTaskOptions {
  taskFile: string;
  author?: string;
  source?: 'cli' | 'mcp' | 'studio';
  note?: string;
  /** Optional exact files supplied by an MCP agent instead of the on-disk proposal directory. */
  files?: readonly { relativePath: string; content: string }[];
  config?: Config;
  signal?: AbortSignal;
}

export interface GenerationReviewOutcome {
  task: GenerationTask;
  state: HandoffState;
  attempt: number;
  attemptRoot: string;
  result: HandoffAttemptResult;
  record?: GenerationRecord;
}

/** Snapshots one authored proposal, validates it, and scores it against the deterministic fallback. */
export async function reviewGenerationTask(
  options: ReviewGenerationTaskOptions,
): Promise<GenerationReviewOutcome> {
  const loaded = await loadHandoffTask(options.taskFile);
  if (loaded.task.taskType !== 'generation') {
    throw new SmartUiError('INVALID_INPUT', 'This task is not a standalone generation task.');
  }
  const task = loaded.task;
  const { taskRoot } = loaded;
  if (loaded.state.status === 'accepted') {
    throw new SmartUiError('POLICY_VIOLATION', 'This task was already accepted.');
  }
  if (loaded.state.status === 'canceled') {
    throw new SmartUiError('POLICY_VIOLATION', 'This task was canceled.');
  }
  return withHandoffTaskLock(taskRoot, async () => {
    const config = options.config ?? (await loadConfig(task.root));
    const proposal = options.files
      ? await validateSuppliedFiles(options.files)
      : await readProposalDirectory(taskRoot, task);
    const allocated = await allocateHandoffAttempt(taskRoot, loaded.state);
    const submitted: HandoffSubmittedFile[] = [];
    for (const file of proposal) {
      const destination = join(allocated.root, 'submitted', file.relativePath);
      await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { flag: 'wx', mode: 0o600 });
      const bytes = new TextEncoder().encode(file.content);
      submitted.push({
        relativePath: file.relativePath,
        mediaType: file.mediaType,
        hash: hashBytes(bytes),
        byteLength: bytes.byteLength,
      });
    }
    const manifestHash = handoffManifestHash(submitted);
    const attempt = allocated.attempt;
    await writeHandoffSubmission(allocated.root, {
      schemaVersion: '1.0',
      taskId: task.taskId,
      taskType: 'generation',
      taskHash: task.taskHash,
      attempt,
      submittedAt: new Date().toISOString(),
      author: options.author ?? 'external',
      source: options.source ?? 'cli',
      ...(options.note ? { note: options.note } : {}),
      files: submitted,
      manifestHash,
    });

    let state = await updateHandoffState(
      taskRoot,
      { taskHash: loaded.state.taskHash, revision: loaded.state.revision },
      (current) => ({
        ...current,
        status: 'reviewing',
        activeAttempt: attempt,
        attempts: [
          ...current.attempts,
          {
            attempt,
            createdAt: new Date().toISOString(),
            status: 'submitted' as const,
            submissionHash: manifestHash,
            author: options.author ?? 'external',
            source: options.source ?? 'cli',
          },
        ],
      }),
    );

    let generation: GenerationResult | undefined;
    let failure: { code: string; message: string } | undefined;
    try {
      generation = await runGenerationReview({
        task,
        config,
        attemptRoot: allocated.root,
        proposal,
        author: options.author ?? 'external',
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      failure = {
        code: error instanceof SmartUiError ? error.code : 'PROVIDER_FAILURE',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      };
    }

    const result = buildAttemptResult({
      task,
      attempt,
      attemptRoot: allocated.root,
      submitted,
      manifestHash,
      ...(generation ? { generation } : {}),
      ...(failure ? { failure } : {}),
    });
    await writeHandoffAttemptResult(allocated.root, result);

    state = await updateHandoffState(
      taskRoot,
      { taskHash: state.taskHash, revision: state.revision },
      (current) => ({
        ...current,
        status: result.outcome === 'passed' ? 'awaiting-decision' : 'revision-needed',
        attempts: current.attempts.map((item) =>
          item.attempt === attempt
            ? {
                ...item,
                status: result.outcome === 'error' ? ('failed' as const) : ('reviewed' as const),
                outcome: result.outcome,
                findingCount: result.findingCount,
                visualSimilarityPercent: result.generation?.visualSimilarityPercent ?? null,
              }
            : item,
        ),
      }),
    );

    return {
      task,
      state,
      attempt,
      attemptRoot: allocated.root,
      result,
      ...(generation ? { record: generation.record } : {}),
    };
  });
}

async function runGenerationReview(options: {
  task: GenerationTask;
  config: Config;
  attemptRoot: string;
  proposal: readonly ProposalFile[];
  author: string;
  signal?: AbortSignal;
}): Promise<GenerationResult> {
  const { task } = options;
  const artifactRoot = join(options.attemptRoot, 'artifacts');
  const store = new LocalArtifactStore(artifactRoot);
  const svgPath = await resolveTaskPath(
    task.taskRoot,
    task.normalizedDesignPath,
    'Normalized design',
  );
  const designEvidence = task.evidence.find((item) => item.role === 'design-reference');
  const input = svgGenerationInputSchema.parse({
    workspaceRoot: task.root,
    svgPath,
    artifactRoot,
    name: task.design.filename.replace(/\.[^.]+$/u, ''),
    mode: task.mode,
    layout: task.layout,
    ...(task.instructions ? { instructions: task.instructions } : {}),
    structuredDesignContext: task.structuredDesignContext,
    presentationSpec: task.presentationSpec,
    ...(designEvidence && task.design.mediaType === 'image/png'
      ? {
          designReference: {
            path: await resolveTaskPath(
              task.taskRoot,
              designEvidence.relativePath,
              'Design evidence',
            ),
            filename: designEvidence.filename,
            mediaType: 'image/png' as const,
            originalHash: designEvidence.originalHash,
            byteLength: designEvidence.byteLength,
            provenance: designEvidence.provenance,
          },
        }
      : {}),
    rendering: {
      background: { kind: 'transparent' },
      locale: task.rendering.locale,
      theme: task.rendering.theme,
    },
    dryRun: false,
    maxPasses: 1,
  });
  const deterministic = new DeterministicHtmlGenerationProvider();
  const limits = { ...options.config.generation.limits };
  const svgBytes = (await readFile(svgPath)).byteLength;
  limits.maxSvgBytes = Math.max(limits.maxSvgBytes, svgBytes);
  limits.maxDecodedCharacters = Math.max(limits.maxDecodedCharacters, svgBytes);
  return new GenerationOrchestrator({
    structure: new LocalSvgStructureProvider(store, limits),
    generator: new HostProposedHtmlGenerationProvider(
      `handoff:${options.author}`,
      options.proposal.map(
        (file): HostProposedGenerationFile => ({
          relativePath: file.relativePath,
          mediaType: file.mediaType,
          content: file.content,
          rationale: 'Authored through a bounded Smart UI generation handoff task.',
        }),
      ),
    ),
    fallbackGenerator: deterministic,
    proposalPolicy: 'prefer-proposal',
    preview: new LoopbackGeneratedPreviewProvider(),
    browser: new PlaywrightBrowserProvider(),
    artifacts: store,
    reporter: new HtmlGenerationReporter(store),
    exporter: new ReproducibleGenerationExporter(task.root),
    config: options.config,
  }).run(input, options.signal);
}

function buildAttemptResult(options: {
  task: GenerationTask;
  attempt: number;
  attemptRoot: string;
  submitted: readonly HandoffSubmittedFile[];
  manifestHash: string;
  generation?: GenerationResult;
  failure?: { code: string; message: string };
}): HandoffAttemptResult {
  const record = options.generation?.record;
  const pass = record?.passes.at(-1);
  const findings = pass?.findings ?? [];
  const blocking = findings.filter((finding) => finding.severity === 'error').length;
  const failed =
    options.failure !== undefined ||
    record === undefined ||
    record.status === 'failed' ||
    record.provenance.hostProposalAccepted !== true;
  return {
    schemaVersion: '1.0',
    taskId: options.task.taskId,
    taskType: 'generation',
    taskHash: options.task.taskHash,
    attempt: options.attempt,
    reviewedAt: new Date().toISOString(),
    outcome: options.failure ? 'error' : failed ? 'failed' : 'passed',
    findingCount: findings.length,
    blockingFindingCount: blocking,
    warnings: (record?.warnings ?? []).slice(0, 50).map((warning) => warning.slice(0, 1_000)),
    failures: options.failure
      ? [options.failure]
      : (record?.failures ?? [])
          .slice(0, 20)
          .map((item) => ({ code: item.code, message: item.message.slice(0, 1_000) })),
    revisionGuidance: revisionGuidance(record, options.failure, findings.length),
    ...(record
      ? {
          generation: {
            generationId: record.id,
            status: record.status,
            stoppedReason: record.stoppedReason,
            manifestHash: record.manifestHash ?? null,
            visualSimilarityPercent: pass?.score ?? null,
            visualMismatchPercent: pass?.diffPercent ?? null,
            recordPath: attemptArtifactPath(options.generation?.recordArtifact),
            reportPath: attemptArtifactPath(record.report),
            archivePath: attemptArtifactPath(record.archive),
            files: options.submitted.map((file) => ({ ...file })),
          },
        }
      : {}),
  };
}

function revisionGuidance(
  record: GenerationRecord | undefined,
  failure: { code: string; message: string } | undefined,
  findingCount: number,
): string[] {
  const guidance: string[] = [];
  if (failure) {
    guidance.push(
      'The proposal was rejected before it produced evidence. Fix the reported problem and run the review again.',
      failure.message,
    );
    return guidance.slice(0, 20);
  }
  if (!record) return ['Re-run the review; no deterministic evidence was produced.'];
  if (record.provenance.hostProposalAccepted !== true) {
    guidance.push(
      'The deterministic fallback matched the design better than the authored proposal. Compare the diff and overlay artifacts, then revise the proposal.',
    );
  }
  if (findingCount > 0) {
    guidance.push(`Resolve the ${findingCount} recorded findings shown in the HTML report.`);
  }
  for (const uncertainty of record.uncertainties.slice(0, 5)) {
    guidance.push(`${uncertainty.code}: ${uncertainty.message}`.slice(0, 1_000));
  }
  return guidance.slice(0, 20);
}

/** Artifact references are store-relative; attempts store them under their own `artifacts/` root. */
function attemptArtifactPath(artifact: { relativePath: string } | undefined): string | null {
  if (!artifact) return null;
  const normalized = artifact.relativePath.replaceAll('\\', '/');
  return normalized ? `artifacts/${normalized}` : null;
}

interface ProposalFile {
  relativePath: string;
  mediaType: 'text/html' | 'text/css' | 'image/svg+xml';
  content: string;
}

/** Reads the exact proposal manifest from the task directory, rejecting anything unexpected. */
async function readProposalDirectory(
  taskRoot: string,
  task: GenerationTask,
): Promise<ProposalFile[]> {
  const root = await resolveTaskPath(taskRoot, task.proposalDirectory, 'Proposal directory');
  const found = new Map<string, ProposalFile>();
  let total = 0;
  for (const entry of await listProposalEntries(root)) {
    const path = join(root, entry);
    const bytes = await readFile(path);
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_PROPOSAL_FILE_BYTES || total > MAX_HANDOFF_SUBMISSION_BYTES) {
      throw new SmartUiError('POLICY_VIOLATION', 'The authored proposal exceeds its byte budget.');
    }
    found.set(entry, {
      relativePath: entry,
      mediaType: proposalMediaType(entry),
      content: decodeUtf8(bytes, entry),
    });
  }
  return orderedManifest(found);
}

async function validateSuppliedFiles(
  files: readonly { relativePath: string; content: string }[],
): Promise<ProposalFile[]> {
  const found = new Map<string, ProposalFile>();
  let total = 0;
  for (const file of files) {
    const relativePath = file.relativePath.replaceAll('\\', '/');
    assertProposalPath(relativePath);
    const bytes = new TextEncoder().encode(file.content);
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_PROPOSAL_FILE_BYTES || total > MAX_HANDOFF_SUBMISSION_BYTES) {
      throw new SmartUiError('POLICY_VIOLATION', 'The authored proposal exceeds its byte budget.');
    }
    if (file.content.includes('\0')) {
      throw new SmartUiError('INVALID_INPUT', `${relativePath} must be UTF-8 text.`);
    }
    found.set(relativePath, {
      relativePath,
      mediaType: proposalMediaType(relativePath),
      content: file.content,
    });
  }
  return orderedManifest(found);
}

function orderedManifest(found: Map<string, ProposalFile>): ProposalFile[] {
  for (const required of [PROPOSAL_ENTRY, PROPOSAL_STYLESHEET]) {
    if (!found.has(required)) {
      throw new SmartUiError(
        'INVALID_INPUT',
        `The proposal must contain ${PROPOSAL_ENTRY} and ${PROPOSAL_STYLESHEET}.`,
      );
    }
  }
  if (found.size > MAX_PROPOSAL_FILES) {
    throw new SmartUiError('POLICY_VIOLATION', 'The authored proposal contains too many files.');
  }
  return [...found.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function listProposalEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) {
      throw new SmartUiError('POLICY_VIOLATION', 'The proposal directory cannot contain links.');
    }
    if (item.isDirectory()) {
      if (item.name !== PROPOSAL_ASSETS) {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          `Only ${PROPOSAL_ASSETS}/ may be created inside the proposal directory.`,
        );
      }
      for (const asset of await readdir(join(root, item.name), { withFileTypes: true })) {
        if (!asset.isFile() || asset.isSymbolicLink()) {
          throw new SmartUiError('POLICY_VIOLATION', `${PROPOSAL_ASSETS}/ may contain only files.`);
        }
        entries.push(`${PROPOSAL_ASSETS}/${asset.name}`);
      }
      continue;
    }
    if (!item.isFile()) continue;
    entries.push(item.name);
  }
  for (const entry of entries) assertProposalPath(entry);
  return entries.sort();
}

function assertProposalPath(relativePath: string): void {
  if (relativePath === PROPOSAL_ENTRY || relativePath === PROPOSAL_STYLESHEET) return;
  const asset = /^assets\/[A-Za-z0-9._-]+\.svg$/u.test(relativePath);
  if (!asset) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `The proposal manifest is exactly ${PROPOSAL_ENTRY}, ${PROPOSAL_STYLESHEET}, and optional ${PROPOSAL_ASSETS}/<name>.svg; found ${relativePath}.`,
    );
  }
}

function proposalMediaType(relativePath: string): 'text/html' | 'text/css' | 'image/svg+xml' {
  const extension = extname(relativePath).toLowerCase();
  if (extension === '.html') return 'text/html';
  if (extension === '.css') return 'text/css';
  return 'image/svg+xml';
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SmartUiError('INVALID_INPUT', `${label} must be strict UTF-8 text.`);
  }
  if (content.includes('\0')) {
    throw new SmartUiError('INVALID_INPUT', `${label} must be text, not binary data.`);
  }
  return content;
}

/** Runs one bounded structure inspection into a temporary root so a dry run retains nothing. */
async function inspectForHandoff(
  workspace: string,
  design: Awaited<ReturnType<typeof prepareDesignInput>>,
  options: PrepareGenerationTaskOptions,
  presentationSpec: PresentationSpec | undefined,
): Promise<{
  viewport: { width: number; height: number; deviceScaleFactor: number };
  sanitizedHash: string;
  decisions: string[];
  uncertainties: string[];
}> {
  const staging = await mkdtemp(join(workspace, '.smart-ui-handoff-'));
  try {
    let svgPath = design.svgPath;
    if (design.normalizedSvg) {
      svgPath = join(staging, 'reference.svg');
      await writeFile(svgPath, design.normalizedSvg, { flag: 'wx', mode: 0o600 });
    }
    const store = new LocalArtifactStore(join(staging, 'artifacts'));
    const input = svgGenerationInputSchema.parse({
      workspaceRoot: workspace,
      svgPath,
      artifactRoot: join(staging, 'artifacts'),
      name: options.name ?? design.name,
      mode: options.mode,
      layout: options.layout,
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(presentationSpec ? { presentationSpec } : {}),
      ...(options.viewport ? { viewport: options.viewport } : {}),
      rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
      dryRun: false,
    });
    const inspection = await new LocalSvgStructureProvider(store, design.structureLimits).inspect(
      input,
      options.signal,
    );
    return {
      viewport: inspection.bundle.viewport,
      sanitizedHash: inspection.bundle.sanitizedHash,
      decisions: [...inspection.bundle.layoutCandidates, ...inspection.bundle.semanticCandidates]
        .slice(0, 50)
        .map((decision) => `${decision.kind}: ${decision.message}`.slice(0, 1_000)),
      uncertainties: inspection.bundle.uncertainties
        .slice(0, 50)
        .map((item) => `${item.code}: ${item.message}`.slice(0, 1_000)),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function generationCommands(taskRoot: string): GenerationTask['commands'] {
  const task = quoteArgument(taskFilePath(taskRoot));
  return {
    review: `smart-ui generation review --task ${task}`,
    status: `smart-ui task status --task ${task} --json`,
    accept: `smart-ui task accept --task ${task} --attempt <number>`,
    cancel: `smart-ui task cancel --task ${task}`,
    mcp: `Use the smart-ui MCP server: call get_handoff_task with taskFile ${task}, author the proposal, then call submit_handoff_generation for the same task hash and revision.`,
  };
}

/** Quotes one path for display without escaping Windows separators into an unusable command. */
export function quoteArgument(value: string): string {
  return `"${value.replaceAll('"', '')}"`;
}

function hashPresentation(spec: PresentationSpec): string {
  return hashBytes(new TextEncoder().encode(JSON.stringify(presentationSpecSchema.parse(spec))));
}

function previewState(task: GenerationTask): HandoffState {
  return {
    schemaVersion: '1.0',
    taskId: task.taskId,
    taskType: 'generation',
    taskHash: task.taskHash,
    revision: 0,
    status: 'prepared',
    updatedAt: task.createdAt,
    activeAttempt: null,
    acceptedAttempt: null,
    attempts: [],
  };
}

function safeName(filename: string): string {
  const cleaned = basename(filename).replace(/[^A-Za-z0-9._-]/gu, '-');
  return cleaned.replace(/^[.]+/u, '') || 'design';
}
