import { z } from 'zod';

export const artifactRefSchema = z
  .object({
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.string().min(1).max(128),
    relativePath: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

const provenanceSchema = z
  .object({
    provider: z.string().min(1),
    source: z.string().min(1),
    capturedAt: z.string().datetime(),
    sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceVersion: z.string().optional(),
    documentId: z.string().optional(),
    nodeId: z.string().optional(),
  })
  .strict();

const edgesSchema = z
  .object({
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
    left: z.number(),
  })
  .strict();

const accessibleStateSchema = z.record(z.string(), z.union([z.string(), z.boolean(), z.number()]));

/** Versioned, framework-neutral evidence for one design element. */
export const designElementSchema = z
  .object({
    validationId: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    figmaNodeId: z.string().min(1).optional(),
    type: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().nonnegative().optional(),
    height: z.number().nonnegative().optional(),
    padding: edgesSchema.optional(),
    margin: edgesSchema.optional(),
    gap: z.number().nonnegative().optional(),
    alignItems: z.string().optional(),
    justifyContent: z.string().optional(),
    overflowX: z.string().optional(),
    overflowY: z.string().optional(),
    color: z.string().optional(),
    backgroundColor: z.string().optional(),
    borderColor: z.string().optional(),
    borderWidth: z.number().nonnegative().optional(),
    borderRadius: z.number().nonnegative().optional(),
    opacity: z.number().min(0).max(1).optional(),
    boxShadow: z.string().optional(),
    fontFamily: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontWeight: z.union([z.string(), z.number()]).optional(),
    lineHeight: z.union([z.string(), z.number()]).optional(),
    letterSpacing: z.union([z.string(), z.number()]).optional(),
    text: z.string().optional(),
    textWrap: z.boolean().optional(),
    lineCount: z.number().int().positive().optional(),
    assetSource: z.string().optional(),
    assetHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    intrinsicWidth: z.number().nonnegative().optional(),
    intrinsicHeight: z.number().nonnegative().optional(),
    objectFit: z.string().optional(),
    objectPosition: z.string().optional(),
    role: z.string().optional(),
    accessibleName: z.string().optional(),
    accessibleState: accessibleStateSchema.optional(),
    keyboardReachable: z.boolean().optional(),
    focusVisible: z.boolean().optional(),
  })
  .strict();

export const findingCategorySchema = z.enum([
  'geometry',
  'typography',
  'appearance',
  'assets',
  'raster',
  'runtime',
  'accessibility',
]);

/** Stable, individually explainable validation result. */
export const validationFindingSchema = z
  .object({
    id: z.string().min(1),
    category: findingCategorySchema,
    severity: z.enum(['error', 'warning', 'info']),
    confidence: z.number().min(0).max(1),
    designNodeId: z.string().optional(),
    targetDomLocator: z.string().optional(),
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
    delta: z.unknown().optional(),
    message: z.string().min(1),
    suggestedRepairCategory: z.string().optional(),
    evidenceArtifacts: z.array(artifactRefSchema).default([]),
  })
  .strict();

const designSourceEvidenceSchema = z
  .object({
    layoutContext: artifactRefSchema.optional(),
    variables: artifactRefSchema.optional(),
    codeConnect: artifactRefSchema.optional(),
    assets: z.array(artifactRefSchema).default([]),
    uncertainties: z.array(z.string()).default([]),
  })
  .strict();

/** Version 1 framework-neutral design evidence. */
export const designContractSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().min(1),
    name: z.string().min(1),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        deviceScaleFactor: z.number().positive().default(1),
      })
      .strict(),
    theme: z.enum(['light', 'dark']).default('light'),
    locale: z.string().default('en-US'),
    component: z
      .object({
        name: z.string().min(1),
        route: z.string().default('/'),
        description: z.string().optional(),
      })
      .strict(),
    reference: artifactRefSchema,
    provenance: provenanceSchema,
    ambiguities: z.array(z.string()).default([]),
    elements: z.array(designElementSchema).default([]),
    sourceEvidence: designSourceEvidenceSchema.default({ assets: [], uncertainties: [] }),
  })
  .strict()
  .superRefine((contract, context) => {
    const ids = new Set<string>();
    for (const [index, element] of contract.elements.entries()) {
      if (!element.validationId) continue;
      if (ids.has(element.validationId)) {
        context.addIssue({
          code: 'custom',
          path: ['elements', index, 'validationId'],
          message: `Duplicate validationId '${element.validationId}'.`,
        });
      }
      ids.add(element.validationId);
    }
  });

const runFailureSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  })
  .strict();

export const stopReasonSchema = z.enum([
  'success',
  'validation-only',
  'dry-run',
  'maximum-passes',
  'repeated-findings',
  'repeated-patch',
  'no-improvement',
  'no-changes',
  'test-regression',
  'policy-violation',
  'canceled',
  'provider-failure',
]);

const patchProposalSchema = z
  .object({
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    files: z.array(z.string()),
    rationale: z.array(z.string()),
  })
  .strict();

export const passRecordSchema = z
  .object({
    passIndex: z.number().int().nonnegative(),
    findings: z.array(validationFindingSchema),
    score: z.number().min(0).max(100),
    changedFiles: z.array(z.string()),
    reverted: z.boolean().default(false),
    proposal: patchProposalSchema.optional(),
    screenshot: artifactRefSchema.optional(),
    diff: artifactRefSchema.optional(),
    overlay: artifactRefSchema.optional(),
    timingsMs: z.record(z.string(), z.number().nonnegative()),
    failures: z.array(runFailureSchema),
  })
  .strict();

/** Versioned deterministic comparison output used by CI and repair providers. */
export const comparisonResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    score: z.number().min(0).max(100),
    findings: z.array(validationFindingSchema),
    diffPercent: z.number().min(0).max(100),
    checkedProperties: z.number().int().nonnegative(),
    passedProperties: z.number().int().nonnegative(),
  })
  .strict();

/** Version 1 immutable record of an orchestration attempt, including failures. */
export const runRecordSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().min(1),
    status: z.enum(['succeeded', 'failed', 'dry-run']),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    targetRoot: z.string().min(1),
    designContract: z.string().min(1),
    inputs: z.record(z.string(), z.string()),
    decisions: z.array(z.object({ kind: z.string(), message: z.string() }).strict()),
    targetArtifact: artifactRefSchema,
    artifacts: z.array(artifactRefSchema),
    changedFiles: z.array(z.string()),
    timingsMs: z.record(z.string(), z.number().nonnegative()),
    warnings: z.array(z.string()),
    failures: z.array(runFailureSchema),
    provenance: z.object({ tool: z.literal('smart-ui'), version: z.string() }).strict(),
    passes: z.array(passRecordSchema).default([]),
    score: z.number().min(0).max(100).optional(),
    stoppedReason: stopReasonSchema,
  })
  .strict();

export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type DesignElement = z.infer<typeof designElementSchema>;
export type ValidationFinding = z.infer<typeof validationFindingSchema>;
export type PassRecord = z.infer<typeof passRecordSchema>;
export type ComparisonResultRecord = z.infer<typeof comparisonResultSchema>;
export type StopReason = z.infer<typeof stopReasonSchema>;
export type DesignContract = z.infer<typeof designContractSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
