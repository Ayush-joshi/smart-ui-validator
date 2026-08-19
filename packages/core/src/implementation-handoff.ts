import { randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AutoFrameworkAdapter } from './auto-framework-adapter.js';
import { loadConfig, type Config } from './config.js';
import { SmartUiError } from './errors.js';
import {
  emptyStructuredDesignContext,
  hashStructuredContext,
  intrinsicPresentationSpec,
  type PresentationSpec,
  type StructuredDesignContext,
} from './generation-contracts.js';
import {
  hashHandoffValue,
  handoffRelativePathSchema,
  type HandoffEvidence,
  type HandoffFrameworkSummary,
  type HandoffState,
  type ImplementationReviewCell,
  type ImplementationTask,
} from './handoff-contracts.js';
import { renderAgentInstructions } from './handoff-instructions.js';
import {
  prepareDesignContextFile,
  prepareDesignInput,
  readPresentationSpecFile,
  readStructuredContextFile,
} from './handoff-intake.js';
import {
  atomicWriteFile,
  createHandoffTask,
  EVIDENCE_DIRNAME,
  handoffTaskRoot,
  hashBytes,
  INSTRUCTIONS_FILE,
  REPOSITORY_DIRNAME,
  resolveTaskPath,
  taskFilePath,
} from './handoff-store.js';
import { LocalArtifactStore } from './artifacts.js';
import { LocalSvgStructureProvider } from './svg-generation-provider.js';
import { svgGenerationInputSchema } from './generation-contracts.js';
import type { RepositoryInspection } from './providers.js';

const MAX_SOURCE_BYTES = 20_000_000;

export interface PrepareImplementationTaskOptions {
  target: string;
  designPath: string;
  route: string;
  writableFiles: readonly string[];
  designContextPath?: string;
  structuredContextPath?: string;
  presentationPath?: string;
  instructions?: string;
  dryRun?: boolean;
  studioRunId?: string;
  config?: Config;
  signal?: AbortSignal;
}

export interface ImplementationTaskPreparation {
  dryRun: boolean;
  task: ImplementationTask;
  state: HandoffState;
  taskRoot: string;
  taskFile: string;
  instructionsFile: string;
}

/** Creates a read-only inspected validate-UI task with exact source-file boundaries. */
export async function prepareImplementationTask(
  options: PrepareImplementationTaskOptions,
): Promise<ImplementationTaskPreparation> {
  const target = await realpath(resolve(options.target));
  const config = options.config ?? (await loadConfig(target));
  const route = validateRoute(options.route);
  const writableFiles = [...new Set(options.writableFiles.map(normalizeRelativePath))];
  if (writableFiles.length === 0) {
    throw new SmartUiError('INVALID_INPUT', 'At least one exact writable file is required.');
  }
  const design = await prepareDesignInput(
    target,
    await realpath(resolve(options.designPath)),
    config.generation.limits,
  );
  let structuredDesignContext: StructuredDesignContext | undefined;
  let contextEvidence: HandoffEvidence | undefined;
  let contextBytes: Uint8Array | undefined;
  if (options.structuredContextPath) {
    structuredDesignContext = await readStructuredContextFile(
      target,
      options.structuredContextPath,
    );
  }
  if (options.designContextPath) {
    const context = await prepareDesignContextFile(
      target,
      options.designContextPath,
      'validate-ui:user-supplied',
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
    ? await readPresentationSpecFile(target, options.presentationPath)
    : undefined;
  const viewportReferences = presentationInput
    ? await Promise.all(
        presentationInput.viewports
          .filter((viewport) => viewport.reference)
          .map(async (viewport) => {
            const reference = viewport.reference!;
            if (reference.mediaType !== 'image/svg+xml' && reference.mediaType !== 'image/png') {
              throw new SmartUiError(
                'INVALID_INPUT',
                `Viewport ${viewport.id} reference must be SVG or PNG for validate-UI.`,
              );
            }
            const prepared = await prepareDesignInput(
              target,
              await realpath(resolve(target, reference.path)),
              config.generation.limits,
            );
            if (prepared.mediaType !== reference.mediaType) {
              throw new SmartUiError(
                'INVALID_INPUT',
                `Viewport ${viewport.id} reference media type does not match its file.`,
              );
            }
            const inspection = await inspectDesign(target, prepared, undefined, options.signal);
            const bytes =
              prepared.mediaType === 'image/svg+xml'
                ? new TextEncoder().encode(inspection.sanitizedXml)
                : await readFile(prepared.originalPath);
            const relativePath = viewportReferencePath(viewport.id, prepared.mediaType);
            return { viewportId: viewport.id, prepared, inspection, bytes, relativePath };
          }),
      )
    : [];
  const inspectedDesign = await inspectDesign(
    target,
    design,
    presentationInput
      ? {
          ...presentationInput,
          viewports: presentationInput.viewports.map((viewport) => ({
            ...viewport,
            ...(viewport.reference
              ? {
                  reference: {
                    ...viewport.reference,
                    path: resolve(target, viewport.reference.path),
                  },
                }
              : {}),
          })),
        }
      : undefined,
    options.signal,
  );
  const presentationSpec =
    presentationInput ?? intrinsicPresentationSpec(inspectedDesign.bundle.viewport);
  const context = structuredDesignContext ?? emptyStructuredDesignContext(options.instructions);
  const inspection = await new AutoFrameworkAdapter().inspect(target);
  const framework = summarizeInspection(inspection);
  const baselines = await Promise.all(
    writableFiles.map(async (relativePath) => sourceBaseline(target, relativePath)),
  );
  const taskId = `task-${randomUUID()}`;
  const taskRoot = handoffTaskRoot(target, 'validate-ui', taskId);
  const designEvidencePath = `${EVIDENCE_DIRNAME}/${safeName(design.filename)}`;
  const normalizedDesignPath =
    design.mediaType === 'image/png'
      ? `${EVIDENCE_DIRNAME}/normalized-design.svg`
      : designEvidencePath;
  const evidence: HandoffEvidence[] = [
    {
      role: design.mediaType === 'image/png' ? 'design-reference' : 'sanitized-design',
      relativePath: designEvidencePath,
      filename: design.filename,
      mediaType: design.mediaType,
      byteLength:
        design.mediaType === 'image/svg+xml'
          ? new TextEncoder().encode(inspectedDesign.sanitizedXml).byteLength
          : design.byteLength,
      hash:
        design.mediaType === 'image/svg+xml'
          ? inspectedDesign.bundle.sanitizedHash
          : design.originalHash,
      originalHash: design.originalHash,
      redacted: false,
      provenance: 'user-supplied',
    },
    ...(contextEvidence ? [contextEvidence] : []),
    ...viewportReferences.map(({ viewportId, prepared, inspection, bytes, relativePath }) => ({
      role: 'viewport-reference' as const,
      relativePath,
      filename: `${viewportId}-${prepared.filename}`,
      mediaType: prepared.mediaType,
      byteLength: bytes.byteLength,
      hash:
        prepared.mediaType === 'image/svg+xml'
          ? inspection.bundle.sanitizedHash
          : prepared.originalHash,
      originalHash: prepared.originalHash,
      redacted: false,
      provenance: `presentation:${viewportId}`,
    })),
  ];
  const body = {
    schemaVersion: '1.0' as const,
    taskType: 'validate-ui' as const,
    taskId,
    createdAt: new Date().toISOString(),
    root: target,
    taskRoot,
    design: {
      filename: design.filename,
      mediaType: design.mediaType,
      byteLength: design.byteLength,
      originalHash: design.originalHash,
      sanitizedHash: inspectedDesign.bundle.sanitizedHash,
      width: inspectedDesign.bundle.viewport.width,
      height: inspectedDesign.bundle.viewport.height,
    },
    evidence,
    structuredDesignContext: context,
    structuredContextHash: hashStructuredContext(context),
    presentationSpec,
    presentationHash: hashHandoffValue(presentationSpec),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    rendering: { locale: 'en-US', theme: 'light' as const, background: 'transparent' },
    decisions: [`Inspected ${framework.framework} repository without executing project code.`],
    uncertainties: (inspection.ambiguities ?? []).slice(0, 50),
    writableFiles,
    commands: implementationCommands(taskRoot, writableFiles),
    ...(options.studioRunId ? { studioRunId: options.studioRunId } : {}),
    route,
    endpointPolicy: endpointPolicy(route, config),
    framework,
    frameworkHash: hashHandoffValue(framework),
    configHash: hashHandoffValue({
      viewports: config.viewports,
      states: config.states,
      policy: config.policy,
    }),
    baselines,
    matrix: buildMatrix(route, presentationSpec, config),
    designContractPath: normalizedDesignPath,
    artifactRoot: `${REPOSITORY_DIRNAME}/review-artifacts`,
  };
  if (options.dryRun) {
    const task = { ...body, taskHash: 'sha256:'.padEnd(71, '0') } as ImplementationTask;
    return {
      dryRun: true,
      task,
      state: previewState(task),
      taskRoot,
      taskFile: taskFilePath(taskRoot),
      instructionsFile: join(taskRoot, INSTRUCTIONS_FILE),
    };
  }
  const created = await createHandoffTask(body);
  const task = created.task as ImplementationTask;
  await mkdir(join(taskRoot, EVIDENCE_DIRNAME), { recursive: true, mode: 0o700 });
  await mkdir(join(taskRoot, REPOSITORY_DIRNAME), { recursive: true, mode: 0o700 });
  const designEvidenceDestination = await resolveTaskPath(
    taskRoot,
    designEvidencePath,
    'Design evidence',
  );
  if (design.mediaType === 'image/svg+xml') {
    await atomicWriteFile(designEvidenceDestination, inspectedDesign.sanitizedXml, true);
  } else {
    await copyFile(design.originalPath, designEvidenceDestination);
  }
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
  for (const reference of viewportReferences) {
    await atomicWriteFile(
      await resolveTaskPath(taskRoot, reference.relativePath, 'Viewport reference'),
      reference.bytes,
      true,
    );
  }
  for (const baseline of baselines) {
    if (!baseline.existed) continue;
    const source = await resolveTargetPath(target, baseline.relativePath);
    const destination = await resolveTaskPath(
      taskRoot,
      `${REPOSITORY_DIRNAME}/baseline/${baseline.relativePath}`,
      'Source baseline',
    );
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
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
  };
}

function summarizeInspection(inspection: RepositoryInspection): HandoffFrameworkSummary {
  return {
    framework: inspection.framework,
    buildSystem: inspection.buildSystem,
    packageManager: inspection.packageManager,
    styling: inspection.styling.slice(0, 50),
    testFrameworks: inspection.testFrameworks.slice(0, 50),
    componentLocations: inspection.componentLocations.slice(0, 50),
    componentCandidates: (inspection.componentCandidates ?? []).slice(0, 50),
    designTokens: (inspection.designTokens ?? []).slice(0, 100),
    conventions: (inspection.conventions ?? []).slice(0, 50),
    routing: (inspection.routing ?? []).slice(0, 50),
    stateManagement: (inspection.stateManagement ?? []).slice(0, 50),
    storybook: inspection.storybook ?? false,
  };
}

async function sourceBaseline(target: string, relativePath: string) {
  const path = await resolveTargetPath(target, relativePath);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new SmartUiError('POLICY_VIOLATION', `${relativePath} must be a regular source file.`);
    }
    if (info.size > MAX_SOURCE_BYTES) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        `${relativePath} exceeds the source-file byte limit.`,
      );
    }
    const bytes = await readFile(path);
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { relativePath, existed: true, hash: hashBytes(bytes), byteLength: bytes.byteLength };
  } catch (error) {
    if (isMissing(error)) return { relativePath, existed: false };
    throw error;
  }
}

async function resolveTargetPath(target: string, relativePath: string): Promise<string> {
  const candidate = resolve(target, relativePath);
  const rel = relative(target, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new SmartUiError('POLICY_VIOLATION', 'Writable file escapes the target root.');
  }
  let current = target;
  for (const segment of rel.split(/[\\/]/u).slice(0, -1)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new SmartUiError('POLICY_VIOLATION', `${relativePath} crosses a symbolic link.`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return candidate;
}

function buildMatrix(
  route: string,
  presentation: PresentationSpec,
  config: Config,
): ImplementationReviewCell[] {
  const primary = presentation.primaryCanvas;
  const viewports = [
    {
      name: primary.id,
      width: primary.width,
      height: primary.height,
      deviceScaleFactor: primary.deviceScaleFactor,
      classification: 'source-fidelity' as const,
    },
    ...presentation.viewports.map((viewport) => ({
      name: viewport.id,
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      classification: viewport.reference
        ? ('alternate-reference-fidelity' as const)
        : ('responsive-robustness' as const),
    })),
    ...config.viewports
      .filter(
        (viewport) =>
          viewport.name !== primary.id &&
          !presentation.viewports.some((item) => item.id === viewport.name),
      )
      .map((viewport) => ({ ...viewport, classification: 'responsive-robustness' as const })),
  ];
  return viewports.flatMap((viewport) =>
    config.states.map((state) => ({
      viewport: {
        name: viewport.name,
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
      },
      state: state.name,
      ...(state.selector ? { selector: state.selector } : {}),
      url: state.url ?? route,
      classification: viewport.classification,
    })),
  );
}

async function inspectDesign(
  target: string,
  design: Awaited<ReturnType<typeof prepareDesignInput>>,
  presentation: PresentationSpec | undefined,
  signal: AbortSignal | undefined,
) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'smart-ui-implementation-intake-'));
  try {
    const svgPath = design.normalizedSvg
      ? join(temporaryRoot, 'normalized-design.svg')
      : design.originalPath;
    if (design.normalizedSvg)
      await writeFile(svgPath, design.normalizedSvg, { flag: 'wx', mode: 0o600 });
    const artifactRoot = join(temporaryRoot, 'artifacts');
    const input = svgGenerationInputSchema.parse({
      workspaceRoot: design.normalizedSvg ? temporaryRoot : target,
      svgPath,
      artifactRoot,
      mode: 'hybrid',
      layout: 'responsive',
      ...(presentation ? { presentationSpec: presentation } : {}),
      rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
    });
    return await new LocalSvgStructureProvider(
      new LocalArtifactStore(artifactRoot),
      (await loadConfig(target)).generation.limits,
    ).inspect(input, signal);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function normalizeRelativePath(value: string): string {
  return handoffRelativePathSchema.parse(value.replaceAll(sep, '/'));
}

function validateRoute(value: string): string {
  const route = new URL(value);
  if (!['http:', 'https:'].includes(route.protocol)) {
    throw new SmartUiError('INVALID_INPUT', 'The review route must use HTTP or HTTPS.');
  }
  return route.href;
}

function endpointPolicy(route: string, config: Config): string[] {
  const origin = new URL(route).origin;
  return [...new Set([origin, ...config.policy.endpointAllowlist])].slice(0, 20);
}

function implementationCommands(taskRoot: string, writableFiles: readonly string[]) {
  const task = quote(join(taskRoot, 'task.json'));
  const files = writableFiles.map((file) => `- ${file}`).join('\n');
  return {
    review: `smart-ui validate-ui review --task ${task}`,
    status: `smart-ui task status --task ${task}`,
    accept: `smart-ui task accept --task ${task} --attempt <number>`,
    cancel: `smart-ui task cancel --task ${task}`,
    mcp: [
      `Complete the validate-UI handoff task at ${task}.`,
      `If discovery is required, call list_handoff_tasks with root ${quote(resolve(taskRoot, '..', '..', '..'))} and taskType "validate-ui".`,
      `Call get_handoff_task with taskFile ${task}, then read its declared evidence and inspect the current contents of every writable file.`,
      'Exact writable files (target-relative):',
      files,
      'Implement the task without changing any other path.',
      'Call submit_handoff_implementation with approved=true, the taskFile, returned taskHash and revision, authoringAgent, and full UTF-8 content for every file listed above.',
      'Report the resulting attempt number, scores, blocking findings, and report path.',
    ].join('\n'),
  };
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 180) || 'evidence';
}

function previewState(task: ImplementationTask): HandoffState {
  return {
    schemaVersion: '1.0',
    taskId: task.taskId,
    taskType: task.taskType,
    taskHash: task.taskHash,
    revision: 0,
    status: 'prepared',
    updatedAt: task.createdAt,
    activeAttempt: null,
    acceptedAttempt: null,
    attempts: [],
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function viewportReferencePath(viewportId: string, mediaType: string): string {
  return `${EVIDENCE_DIRNAME}/viewport-${safeName(viewportId)}.${mediaType === 'image/png' ? 'png' : 'svg'}`;
}
