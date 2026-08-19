import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { presentationSpecSchema, structuredDesignContextSchema } from './generation-contracts.js';

/**
 * Persistent bounded handoff tasks. A task is the single durable contract that lets CLI, Studio, an
 * MCP-connected agent, an external agent, or a human converge on the same immutable attempts and the
 * same deterministic review evidence. Task content is untrusted evidence; it never widens policy.
 */

export const HANDOFF_TASK_ID = /^task-[0-9a-f-]{36}$/u;
export const HANDOFF_SCHEMA_VERSION = '1.0';
export const MAX_HANDOFF_ATTEMPTS = 50;
export const MAX_HANDOFF_WRITABLE_FILES = 40;
export const MAX_HANDOFF_EVIDENCE_FILES = 20;
export const MAX_HANDOFF_SUBMISSION_FILES = 100;
export const MAX_HANDOFF_SUBMISSION_BYTES = 20_000_000;
export const MAX_HANDOFF_NOTE_CHARACTERS = 4_000;

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value), 'Path must be absolute.');

/** Relative POSIX path with no traversal, drive letter, or absolute prefix. */
export const handoffRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u,
    'Paths must be relative POSIX paths without traversal.',
  )
  .refine(
    (value) => !value.split('/').some((segment) => segment === '.' || segment === '..'),
    'Paths cannot traverse.',
  );

export const handoffTaskTypeSchema = z.enum(['generation', 'validate-ui']);

export const handoffStatusSchema = z.enum([
  'prepared',
  'awaiting-author',
  'reviewing',
  'awaiting-decision',
  'revision-needed',
  'accepted',
  'failed',
  'canceled',
]);

const evidenceRoleSchema = z.enum([
  'design-reference',
  'sanitized-design',
  'design-context',
  'structured-context',
  'presentation-spec',
  'viewport-reference',
]);

const handoffEvidenceSchema = z
  .object({
    role: evidenceRoleSchema,
    relativePath: handoffRelativePathSchema,
    filename: z.string().min(1).max(200),
    mediaType: z.string().min(1).max(100),
    byteLength: z.number().int().positive().max(50_000_000),
    hash: sha256Schema,
    originalHash: sha256Schema,
    redacted: z.boolean().default(false),
    provenance: z.string().min(1).max(200),
  })
  .strict();

const handoffDesignSchema = z
  .object({
    filename: z.string().min(1).max(200),
    mediaType: z.enum(['image/svg+xml', 'image/png']),
    byteLength: z.number().int().positive().max(50_000_000),
    originalHash: sha256Schema,
    sanitizedHash: sha256Schema.optional(),
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
  })
  .strict();

const handoffRenderingSchema = z
  .object({
    locale: z.string().min(1).max(100),
    theme: z.enum(['light', 'dark']),
    background: z.string().min(1).max(100),
  })
  .strict();

const handoffCommandsSchema = z
  .object({
    review: z.string().min(1).max(4_000),
    status: z.string().min(1).max(4_000),
    accept: z.string().min(1).max(4_000),
    cancel: z.string().min(1).max(4_000),
    mcp: z.string().min(1).max(4_000),
  })
  .strict();

const handoffTaskBaseShape = {
  schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
  taskId: z.string().regex(HANDOFF_TASK_ID),
  taskHash: sha256Schema,
  createdAt: z.string().datetime(),
  /** Containment boundary: the generation workspace or the target repository root. */
  root: absolutePathSchema,
  taskRoot: absolutePathSchema,
  design: handoffDesignSchema,
  evidence: z.array(handoffEvidenceSchema).max(MAX_HANDOFF_EVIDENCE_FILES),
  structuredDesignContext: structuredDesignContextSchema,
  structuredContextHash: sha256Schema,
  presentationSpec: presentationSpecSchema,
  presentationHash: sha256Schema,
  /** Literal user instruction. Untrusted text that outranks memory but never widens policy. */
  instructions: z.string().max(MAX_HANDOFF_NOTE_CHARACTERS).optional(),
  rendering: handoffRenderingSchema,
  decisions: z.array(z.string().min(1).max(1_000)).max(50).default([]),
  uncertainties: z.array(z.string().min(1).max(1_000)).max(50).default([]),
  /** Exact writable locations. Generation writes task-relative paths; validate-UI target-relative. */
  writableFiles: z.array(handoffRelativePathSchema).min(1).max(MAX_HANDOFF_WRITABLE_FILES),
  commands: handoffCommandsSchema,
  studioRunId: z
    .string()
    .regex(/^run-[0-9a-f-]{36}$/u)
    .optional(),
} as const;

export const generationTaskSchema = z
  .object({
    ...handoffTaskBaseShape,
    taskType: z.literal('generation'),
    mode: z.enum(['exact', 'hybrid', 'semantic']),
    layout: z.enum(['fixed', 'responsive', 'component']),
    /** Task-relative directory the author may write; the only writable location for generation. */
    proposalDirectory: handoffRelativePathSchema,
    /** Design evidence copied inside the task, used to re-run deterministic generation review. */
    normalizedDesignPath: handoffRelativePathSchema,
  })
  .strict();

const frameworkSummarySchema = z
  .object({
    framework: z.enum(['react', 'angular', 'unknown']),
    buildSystem: z.string().max(200).nullable(),
    packageManager: z.string().max(200).nullable(),
    styling: z.array(z.string().max(200)).max(50),
    testFrameworks: z.array(z.string().max(200)).max(50),
    componentLocations: z.array(z.string().max(500)).max(50),
    componentCandidates: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            relativePath: z.string().min(1).max(1_024),
            kind: z.enum(['component', 'directive', 'service']),
            selector: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(50),
    designTokens: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            source: z.string().min(1).max(500),
            kind: z.enum(['css-custom-property', 'typescript', 'scss']),
            value: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(100),
    conventions: z.array(z.string().max(500)).max(50),
    routing: z.array(z.string().max(500)).max(50),
    stateManagement: z.array(z.string().max(500)).max(50),
    storybook: z.boolean(),
  })
  .strict();

const fileBaselineSchema = z
  .object({
    relativePath: handoffRelativePathSchema,
    existed: z.boolean(),
    hash: sha256Schema.optional(),
    byteLength: z.number().int().nonnegative().max(20_000_000).optional(),
  })
  .strict();

const reviewCellSchema = z
  .object({
    viewport: z
      .object({
        name: z.string().min(1).max(100),
        width: z.number().int().positive().max(10_000),
        height: z.number().int().positive().max(10_000),
        deviceScaleFactor: z.number().positive().max(4),
      })
      .strict(),
    state: z.enum(['default', 'hover', 'focus', 'active', 'disabled', 'loading', 'empty', 'error']),
    selector: z.string().min(1).max(500).optional(),
    url: z.string().url().max(2_048).optional(),
    /** Only a pinned reference earns a fidelity score; everything else is robustness only. */
    classification: z.enum([
      'source-fidelity',
      'alternate-reference-fidelity',
      'responsive-robustness',
    ]),
  })
  .strict();

export const implementationTaskSchema = z
  .object({
    ...handoffTaskBaseShape,
    taskType: z.literal('validate-ui'),
    route: z.string().url().max(2_048),
    endpointPolicy: z.array(z.string().url().max(2_048)).max(20),
    framework: frameworkSummarySchema,
    frameworkHash: sha256Schema,
    configHash: sha256Schema,
    baselines: z.array(fileBaselineSchema).min(1).max(MAX_HANDOFF_WRITABLE_FILES),
    matrix: z.array(reviewCellSchema).min(1).max(64),
    /** Task-relative contract used by every review capture. */
    designContractPath: handoffRelativePathSchema,
    artifactRoot: handoffRelativePathSchema,
  })
  .strict();

export const handoffTaskSchema = z.discriminatedUnion('taskType', [
  generationTaskSchema,
  implementationTaskSchema,
]);

const attemptStatusSchema = z.enum(['submitted', 'reviewed', 'failed']);

const attemptReferenceSchema = z
  .object({
    attempt: z.number().int().positive().max(MAX_HANDOFF_ATTEMPTS),
    createdAt: z.string().datetime(),
    status: attemptStatusSchema,
    submissionHash: sha256Schema,
    author: z.string().min(1).max(200),
    source: z.enum(['cli', 'mcp', 'studio']),
    outcome: z.enum(['passed', 'failed', 'error']).optional(),
    visualSimilarityPercent: z.number().min(0).max(100).nullable().optional(),
    findingCount: z.number().int().nonnegative().max(100_000).optional(),
  })
  .strict();

export const handoffStateSchema = z
  .object({
    schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
    taskId: z.string().regex(HANDOFF_TASK_ID),
    taskType: handoffTaskTypeSchema,
    taskHash: sha256Schema,
    /** Monotonic revision. Every mutation compares it before an atomic replacement. */
    revision: z.number().int().nonnegative().max(1_000_000),
    status: handoffStatusSchema,
    updatedAt: z.string().datetime(),
    activeAttempt: z.number().int().positive().max(MAX_HANDOFF_ATTEMPTS).nullable(),
    acceptedAttempt: z.number().int().positive().max(MAX_HANDOFF_ATTEMPTS).nullable(),
    attempts: z.array(attemptReferenceSchema).max(MAX_HANDOFF_ATTEMPTS),
    studio: z
      .object({
        runId: z.string().regex(/^run-[0-9a-f-]{36}$/u),
        verifiedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const handoffSubmittedFileSchema = z
  .object({
    relativePath: handoffRelativePathSchema,
    mediaType: z.string().min(1).max(100),
    hash: sha256Schema,
    byteLength: z.number().int().nonnegative().max(MAX_HANDOFF_SUBMISSION_BYTES),
  })
  .strict();

export const handoffSubmissionSchema = z
  .object({
    schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
    taskId: z.string().regex(HANDOFF_TASK_ID),
    taskType: handoffTaskTypeSchema,
    taskHash: sha256Schema,
    attempt: z.number().int().positive().max(MAX_HANDOFF_ATTEMPTS),
    submittedAt: z.string().datetime(),
    author: z.string().min(1).max(200),
    source: z.enum(['cli', 'mcp', 'studio']),
    note: z.string().max(MAX_HANDOFF_NOTE_CHARACTERS).optional(),
    files: z.array(handoffSubmittedFileSchema).min(1).max(MAX_HANDOFF_SUBMISSION_FILES),
    manifestHash: sha256Schema,
  })
  .strict();

const generationOutcomeSchema = z
  .object({
    generationId: z.string().min(1).max(200),
    status: z.string().min(1).max(100),
    stoppedReason: z.string().min(1).max(100),
    manifestHash: sha256Schema.nullable(),
    visualSimilarityPercent: z.number().min(0).max(100).nullable(),
    visualMismatchPercent: z.number().min(0).max(100).nullable(),
    recordPath: handoffRelativePathSchema.nullable(),
    reportPath: handoffRelativePathSchema.nullable(),
    archivePath: handoffRelativePathSchema.nullable(),
    files: z.array(handoffSubmittedFileSchema).max(MAX_HANDOFF_SUBMISSION_FILES),
  })
  .strict();

const implementationCellResultSchema = z
  .object({
    viewport: z.string().min(1).max(100),
    state: z.string().min(1).max(100),
    classification: reviewCellSchema.shape.classification,
    runRecordPath: handoffRelativePathSchema.nullable(),
    score: z.number().min(0).max(100).nullable(),
    visualMismatchPercent: z.number().min(0).max(100).nullable(),
    findingCount: z.number().int().nonnegative().max(100_000),
    blockingFindingCount: z.number().int().nonnegative().max(100_000),
    status: z.enum(['succeeded', 'failed', 'dry-run']),
  })
  .strict();

const implementationOutcomeSchema = z
  .object({
    route: z.string().url().max(2_048),
    changedFiles: z.array(handoffRelativePathSchema).max(MAX_HANDOFF_WRITABLE_FILES),
    indexPath: handoffRelativePathSchema.nullable(),
    cells: z.array(implementationCellResultSchema).max(64),
  })
  .strict();

export const handoffAttemptResultSchema = z
  .object({
    schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
    taskId: z.string().regex(HANDOFF_TASK_ID),
    taskType: handoffTaskTypeSchema,
    taskHash: sha256Schema,
    attempt: z.number().int().positive().max(MAX_HANDOFF_ATTEMPTS),
    reviewedAt: z.string().datetime(),
    outcome: z.enum(['passed', 'failed', 'error']),
    findingCount: z.number().int().nonnegative().max(100_000),
    blockingFindingCount: z.number().int().nonnegative().max(100_000),
    warnings: z.array(z.string().min(1).max(1_000)).max(50),
    failures: z
      .array(z.object({ code: z.string().max(100), message: z.string().max(1_000) }).strict())
      .max(20),
    revisionGuidance: z.array(z.string().min(1).max(1_000)).max(20),
    generation: generationOutcomeSchema.optional(),
    implementation: implementationOutcomeSchema.optional(),
  })
  .strict();

/** Compact ordered evidence index for a validate-UI review attempt. */
export const implementationReviewIndexSchema = z
  .object({
    schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
    taskId: z.string().regex(HANDOFF_TASK_ID),
    attempt: z.number().int().positive().max(MAX_HANDOFF_ATTEMPTS),
    route: z.string().url().max(2_048),
    createdAt: z.string().datetime(),
    cells: z.array(implementationCellResultSchema).max(64),
  })
  .strict();

export type HandoffTaskType = z.infer<typeof handoffTaskTypeSchema>;
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;
export type HandoffEvidence = z.infer<typeof handoffEvidenceSchema>;
export type GenerationTask = z.infer<typeof generationTaskSchema>;
export type ImplementationTask = z.infer<typeof implementationTaskSchema>;
export type HandoffTask = z.infer<typeof handoffTaskSchema>;
export type HandoffState = z.infer<typeof handoffStateSchema>;
export type HandoffSubmission = z.infer<typeof handoffSubmissionSchema>;
export type HandoffSubmittedFile = z.infer<typeof handoffSubmittedFileSchema>;
export type HandoffAttemptResult = z.infer<typeof handoffAttemptResultSchema>;
export type ImplementationReviewIndex = z.infer<typeof implementationReviewIndexSchema>;
export type ImplementationReviewCell = z.infer<typeof reviewCellSchema>;
export type HandoffFrameworkSummary = z.infer<typeof frameworkSummarySchema>;

/** Order-independent hash so a task or manifest hash never depends on property insertion order. */
export function hashHandoffValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`;
}

export function computeHandoffTaskHash(task: Omit<HandoffTask, 'taskHash'>): string {
  return hashHandoffValue(task);
}

export function handoffManifestHash(
  files: readonly { relativePath: string; hash: string; mediaType?: string }[],
): string {
  return hashHandoffValue(
    [...files]
      .map((file) => [file.relativePath, file.mediaType ?? '', file.hash])
      .sort((left, right) => left[0]!.localeCompare(right[0]!)),
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}
