import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { artifactRefSchema, validationFindingSchema } from './schemas.js';

export const generationModeSchema = z.enum(['exact', 'hybrid', 'semantic']);
export const generationLayoutSchema = z.enum(['fixed', 'responsive', 'component']);

export const svgGenerationInputSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    svgPath: z.string().min(1),
    artifactRoot: z.string().min(1),
    exportRoot: z.string().min(1).optional(),
    name: z.string().min(1).max(200).optional(),
    mode: generationModeSchema.default('hybrid'),
    layout: generationLayoutSchema.default('responsive'),
    instructions: z.string().max(4_000).optional(),
    viewport: z
      .object({
        width: z.number().int().positive().max(10_000),
        height: z.number().int().positive().max(10_000),
        deviceScaleFactor: z.number().positive().max(4).default(1),
      })
      .strict()
      .optional(),
    rendering: z
      .object({
        background: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('transparent') }).strict(),
          z.object({ kind: z.literal('color'), value: z.string().min(1).max(100) }).strict(),
        ]),
        locale: z.string().min(1).max(100).default('en-US'),
        theme: z.enum(['light', 'dark']).default('light'),
      })
      .strict()
      .default({ background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' }),
    dryRun: z.boolean().default(false),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    maxPasses: z.number().int().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    for (const field of ['workspaceRoot', 'svgPath', 'artifactRoot', 'exportRoot'] as const) {
      const value = input[field];
      if (value && !isAbsolute(value)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must be an absolute path.`,
        });
      }
    }
  });

const boundsSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

export const designBundleNodeSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().optional(),
    type: z.string().min(1),
    parentId: z.string().optional(),
    childIds: z.array(z.string()),
    zOrder: z.number().int().nonnegative(),
    visible: z.boolean(),
    attributes: z.record(z.string(), z.string()),
    computedStyle: z.record(z.string(), z.string()),
    bounds: boundsSchema.optional(),
    transform: z.string().optional(),
    text: z.string().optional(),
    outlinedText: z.boolean().default(false),
  })
  .strict();

const generationDecisionSchema = z
  .object({
    kind: z.string().min(1),
    message: z.string().min(1),
    sourceNodeIds: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1),
    provenance: z.string().min(1),
  })
  .strict();

const generationUncertaintySchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    sourceNodeIds: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const sanitizationSummarySchema = z
  .object({
    accepted: z.boolean(),
    nodeCount: z.number().int().nonnegative(),
    maxDepth: z.number().int().nonnegative(),
    attributeCount: z.number().int().nonnegative(),
    pathDataCharacters: z.number().int().nonnegative(),
    gradientCount: z.number().int().nonnegative(),
    filterCount: z.number().int().nonnegative(),
    embeddedImageCount: z.number().int().nonnegative(),
    embeddedImageBytes: z.number().int().nonnegative(),
    decisions: z.array(z.string()),
    rejectionCodes: z.array(z.string()),
  })
  .strict();

export const designBundleSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().min(1),
    name: z.string().min(1),
    originalInputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sanitizedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    capturedAt: z.string().datetime(),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        deviceScaleFactor: z.number().positive(),
      })
      .strict(),
    referenceBackground: z.string(),
    sanitizedSvg: artifactRefSchema,
    sanitization: sanitizationSummarySchema,
    scene: z
      .object({ rootNodeId: z.string().min(1), nodes: z.array(designBundleNodeSchema) })
      .strict(),
    repeatedValues: z.record(z.string(), z.array(z.string())),
    layoutCandidates: z.array(generationDecisionSchema),
    semanticCandidates: z.array(generationDecisionSchema),
    uncertainties: z.array(generationUncertaintySchema),
    unsupportedConstructs: z.array(z.string()),
    fontPolicy: z
      .object({ fallbackStack: z.string(), unavailableFonts: z.array(z.string()) })
      .strict(),
    instructions: z.string().optional(),
    provenance: z
      .object({ provider: z.string(), version: z.string(), source: z.string() })
      .strict(),
  })
  .strict();

export interface GeneratedHtmlFile {
  relativePath: string;
  mediaType: string;
  bytes: Uint8Array;
  rationale: string;
  sourceNodeIds: string[];
}

export interface GeneratedHtmlBundle {
  files: GeneratedHtmlFile[];
  decisions: GenerationDecision[];
  uncertainties: GenerationUncertainty[];
  finalMode: GenerationMode;
}

const generatedFileRecordSchema = z
  .object({
    relativePath: z.string().min(1),
    mediaType: z.string().min(1),
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
    artifact: artifactRefSchema,
    rationale: z.string(),
    sourceNodeIds: z.array(z.string()),
  })
  .strict();

const generationPassSchema = z
  .object({
    passIndex: z.number().int().nonnegative(),
    outputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    findings: z.array(validationFindingSchema),
    score: z.number().min(0).max(100),
    diffPercent: z.number().min(0).max(100),
    screenshot: artifactRefSchema,
    diff: artifactRefSchema,
    overlay: artifactRefSchema,
    timingsMs: z.record(z.string(), z.number().nonnegative()),
  })
  .strict();

const viewportEvidenceSchema = z
  .object({
    name: z.string(),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        deviceScaleFactor: z.number().positive(),
      })
      .strict(),
    classification: z.enum([
      'source-fidelity',
      'alternate-reference-fidelity',
      'responsive-robustness',
    ]),
    screenshot: artifactRefSchema,
    similarity: z.number().min(0).max(100).optional(),
    diffPercent: z.number().min(0).max(100).optional(),
    findings: z.array(validationFindingSchema),
  })
  .strict();

export const generationStopReasonSchema = z.enum([
  'success',
  'exact-fallback',
  'dry-run',
  'maximum-passes',
  'repeated-output',
  'no-improvement',
  'invalid-svg',
  'unsafe-svg',
  'invalid-output',
  'policy-violation',
  'canceled',
  'provider-failure',
]);

export const generationRecordSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    generatorVersion: z.string().min(1),
    id: z.string().min(1),
    status: z.enum(['succeeded', 'failed', 'dry-run', 'completed-with-warnings']),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    stoppedReason: generationStopReasonSchema,
    originalInputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sanitizedHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    sanitizedSource: artifactRefSchema.optional(),
    sanitization: sanitizationSummarySchema,
    input: z
      .object({
        name: z.string(),
        requestedMode: generationModeSchema,
        finalMode: generationModeSchema.optional(),
        layout: generationLayoutSchema,
        viewport: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            deviceScaleFactor: z.number().positive(),
          })
          .strict()
          .optional(),
        renderingBackground: z.string(),
        instructionsHash: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    provider: z.object({ name: z.string(), version: z.string() }).strict(),
    generatedFiles: z.array(generatedFileRecordSchema),
    decisions: z.array(generationDecisionSchema),
    uncertainties: z.array(generationUncertaintySchema),
    passes: z.array(generationPassSchema),
    viewports: z.array(viewportEvidenceSchema),
    artifacts: z.array(artifactRefSchema),
    archive: artifactRefSchema.optional(),
    report: artifactRefSchema.optional(),
    timingsMs: z.record(z.string(), z.number().nonnegative()),
    warnings: z.array(z.string()),
    failures: z.array(
      z.object({ code: z.string(), message: z.string(), recoverable: z.boolean() }).strict(),
    ),
    canceled: z.boolean(),
    provenance: z.object({ tool: z.literal('smart-ui'), hostProposal: z.boolean() }).strict(),
  })
  .strict();

export type SvgGenerationInput = z.infer<typeof svgGenerationInputSchema>;
export type DesignBundleNode = z.infer<typeof designBundleNodeSchema>;
export type DesignBundle = z.infer<typeof designBundleSchema>;
export type GenerationDecision = z.infer<typeof generationDecisionSchema>;
export type GenerationUncertainty = z.infer<typeof generationUncertaintySchema>;
export type SanitizationSummary = z.infer<typeof sanitizationSummarySchema>;
export type GenerationMode = z.infer<typeof generationModeSchema>;
export type GenerationLayout = z.infer<typeof generationLayoutSchema>;
export type GenerationRecord = z.infer<typeof generationRecordSchema>;
export type GenerationStopReason = z.infer<typeof generationStopReasonSchema>;
