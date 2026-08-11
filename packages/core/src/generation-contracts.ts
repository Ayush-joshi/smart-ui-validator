import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { artifactRefSchema, validationFindingSchema } from './schemas.js';

export const generationModeSchema = z.enum(['exact', 'hybrid', 'semantic']);
export const generationLayoutSchema = z.enum(['fixed', 'responsive', 'component']);

export const MAX_PRESENTATION_VIEWPORTS = 8;
export const MAX_PRESENTATION_TOTAL_PIXELS = 50_000_000;
export const MAX_STRUCTURED_CONTEXT_CHARACTERS = 20_000;
const MAX_CONTEXT_ITEMS = 100;
const MAX_CONTEXT_FIELD_CHARACTERS = 4_000;
const boundedContextText = z.string().min(1).max(MAX_CONTEXT_FIELD_CHARACTERS);
const sourceNodeIdsSchema = z.array(z.string().min(1).max(200)).max(100).default([]);
const stableIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const structuredDesignContextSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    exactCopy: z
      .array(
        z
          .object({
            id: stableIdSchema,
            label: z.string().min(1).max(200),
            text: boundedContextText,
            locale: z.string().min(1).max(100).optional(),
            sourceNodeIds: sourceNodeIdsSchema,
            provenance: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(MAX_CONTEXT_ITEMS)
      .default([]),
    designTokens: z
      .array(
        z
          .object({
            name: stableIdSchema,
            kind: z.enum(['color', 'typography', 'spacing', 'radius', 'border', 'shadow', 'other']),
            value: boundedContextText,
            usage: z.string().max(1_000).optional(),
            provenance: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(MAX_CONTEXT_ITEMS)
      .default([]),
    componentSemantics: z
      .array(
        z
          .object({
            id: stableIdSchema,
            name: z.string().min(1).max(200),
            role: z.string().min(1).max(200),
            stateOrVariant: z.string().max(500).optional(),
            sourceNodeIds: sourceNodeIdsSchema,
            provenance: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(MAX_CONTEXT_ITEMS)
      .default([]),
    interactions: z
      .array(
        z
          .object({
            id: stableIdSchema,
            trigger: z.string().min(1).max(500),
            target: z.string().min(1).max(500),
            resultingBehavior: boundedContextText,
            keyboardNotes: z.string().max(1_000).optional(),
            sourceNodeIds: sourceNodeIdsSchema,
            provenance: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(MAX_CONTEXT_ITEMS)
      .default([]),
    generalNotes: z.string().max(4_000).optional(),
  })
  .strict()
  .superRefine((context, refinement) => {
    for (const [key, items] of [
      ['exactCopy', context.exactCopy],
      ['designTokens', context.designTokens],
      ['componentSemantics', context.componentSemantics],
      ['interactions', context.interactions],
    ] as const) {
      const ids = items.map((item) => ('id' in item ? item.id : item.name));
      if (new Set(ids).size !== ids.length) {
        refinement.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} identifiers must be unique.`,
        });
      }
    }
    if (structuredContextCharacterCount(context) > MAX_STRUCTURED_CONTEXT_CHARACTERS) {
      refinement.addIssue({
        code: 'custom',
        message: `Structured design context exceeds ${MAX_STRUCTURED_CONTEXT_CHARACTERS} total characters.`,
      });
    }
  });

const presentationViewportSchema = z
  .object({
    id: stableIdSchema,
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
    deviceScaleFactor: z.number().positive().max(4).default(1),
  })
  .strict();

export const presentationSpecSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    primaryCanvas: presentationViewportSchema,
    fit: z.enum(['intrinsic', 'contain', 'cover', 'stretch']),
    horizontalAlignment: z.enum(['start', 'center', 'end']),
    verticalAlignment: z.enum(['start', 'center', 'end']),
    viewports: z
      .array(
        presentationViewportSchema.extend({
          requirement: z.enum(['required', 'advisory']),
          reference: z
            .object({
              path: z.string().min(1).max(4_096),
              mediaType: z.enum(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp']),
            })
            .strict()
            .optional(),
        }),
      )
      .max(MAX_PRESENTATION_VIEWPORTS)
      .default([]),
  })
  .strict()
  .superRefine((spec, refinement) => {
    const ids = [spec.primaryCanvas.id, ...spec.viewports.map((viewport) => viewport.id)];
    if (new Set(ids).size !== ids.length) {
      refinement.addIssue({
        code: 'custom',
        path: ['viewports'],
        message: 'Presentation viewport identifiers must be unique.',
      });
    }
    const totalPixels = [spec.primaryCanvas, ...spec.viewports].reduce(
      (total, viewport) =>
        total + viewport.width * viewport.height * viewport.deviceScaleFactor ** 2,
      0,
    );
    if (totalPixels > MAX_PRESENTATION_TOTAL_PIXELS) {
      refinement.addIssue({
        code: 'custom',
        path: ['viewports'],
        message: `Presentation viewports exceed the ${MAX_PRESENTATION_TOTAL_PIXELS} total rendered-pixel budget.`,
      });
    }
  });

export function intrinsicPresentationSpec(viewport: {
  width: number;
  height: number;
  deviceScaleFactor: number;
}): PresentationSpec {
  return presentationSpecSchema.parse({
    schemaVersion: '1.0',
    primaryCanvas: { id: 'source', ...viewport },
    fit: 'intrinsic',
    horizontalAlignment: 'start',
    verticalAlignment: 'start',
    viewports: [],
  });
}

export function emptyStructuredDesignContext(generalNotes?: string): StructuredDesignContext {
  return structuredDesignContextSchema.parse({
    schemaVersion: '1.0',
    exactCopy: [],
    designTokens: [],
    componentSemantics: [],
    interactions: [],
    ...(generalNotes ? { generalNotes } : {}),
  });
}

export function structuredContextCharacterCount(context: unknown): number {
  if (typeof context === 'string') return context.length;
  if (Array.isArray(context))
    return context.reduce((total, item) => total + structuredContextCharacterCount(item), 0);
  if (!context || typeof context !== 'object') return 0;
  return Object.values(context).reduce<number>(
    (total, item) => total + structuredContextCharacterCount(item),
    0,
  );
}

export function hashStructuredContext(context: StructuredDesignContext): string {
  const validated = structuredDesignContextSchema.parse(context);
  return `sha256:${createHash('sha256').update(JSON.stringify(validated), 'utf8').digest('hex')}`;
}

export function resolveStructuredDesignContext(
  input: Pick<SvgGenerationInput, 'structuredDesignContext' | 'instructions'>,
): StructuredDesignContext {
  if (input.structuredDesignContext)
    return structuredDesignContextSchema.parse(input.structuredDesignContext);
  return emptyStructuredDesignContext(input.instructions);
}

export function resolvePresentationSpec(
  input: Pick<SvgGenerationInput, 'presentationSpec'>,
  sourceViewport: { width: number; height: number; deviceScaleFactor: number },
): PresentationSpec {
  return input.presentationSpec
    ? presentationSpecSchema.parse(input.presentationSpec)
    : intrinsicPresentationSpec(sourceViewport);
}

export const svgGenerationInputSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    svgPath: z.string().min(1),
    artifactRoot: z.string().min(1),
    generationId: z
      .string()
      .regex(/^generation-[a-f0-9-]{36}$/)
      .optional(),
    exportRoot: z.string().min(1).optional(),
    name: z.string().min(1).max(200).optional(),
    mode: generationModeSchema.default('hybrid'),
    layout: generationLayoutSchema.default('responsive'),
    instructions: z.string().max(4_000).optional(),
    structuredDesignContext: structuredDesignContextSchema.optional(),
    presentationSpec: presentationSpecSchema.optional(),
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
    for (const [index, viewport] of (input.presentationSpec?.viewports ?? []).entries()) {
      if (viewport.reference && !isAbsolute(viewport.reference.path)) {
        context.addIssue({
          code: 'custom',
          path: ['presentationSpec', 'viewports', index, 'reference', 'path'],
          message: 'Presentation reference paths must be absolute.',
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

export const designBundleV1Schema = z
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

export const designBundleV2Schema = designBundleV1Schema
  .omit({ schemaVersion: true, instructions: true })
  .extend({
    schemaVersion: z.literal('2.0'),
    structuredDesignContext: structuredDesignContextSchema,
    structuredContextHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    presentationSpec: presentationSpecSchema,
  })
  .strict();

const designBundleReaderSchema = z.discriminatedUnion('schemaVersion', [
  designBundleV1Schema,
  designBundleV2Schema,
]);

/** Compatibility reader that deterministically upgrades supported 1.0 bundles to the 2.0 model. */
export const designBundleSchema = designBundleReaderSchema.transform((bundle) =>
  bundle.schemaVersion === '2.0' ? bundle : upgradeDesignBundleV1(bundle),
);

function upgradeDesignBundleV1(bundle: z.infer<typeof designBundleV1Schema>) {
  const { instructions, ...legacy } = bundle;
  const structuredDesignContext = emptyStructuredDesignContext(instructions);
  return designBundleV2Schema.parse({
    ...legacy,
    schemaVersion: '2.0',
    structuredDesignContext,
    structuredContextHash: hashStructuredContext(structuredDesignContext),
    presentationSpec: intrinsicPresentationSpec(bundle.viewport),
  });
}

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
    reference: artifactRefSchema.optional(),
    diff: artifactRefSchema,
    overlay: artifactRefSchema,
    provider: z.object({ name: z.string(), version: z.string() }).strict().optional(),
    accepted: z.boolean().default(true),
    reverted: z.boolean().default(false),
    proposalHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
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

export const generationRecordV1Schema = z
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
    designBundle: artifactRefSchema.optional(),
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
    manifestHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
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
    provenance: z
      .object({
        tool: z.enum(['smart-ui', 'smart-ui-mcp', 'smart-ui-studio']),
        hostProposal: z.boolean(),
        hostProposalAccepted: z.boolean().optional(),
        host: z.string().min(1).max(200).optional(),
        proposalHash: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();

export const generationRecordV2Schema = generationRecordV1Schema
  .omit({ schemaVersion: true, input: true })
  .extend({
    schemaVersion: z.literal('2.0'),
    input: generationRecordV1Schema.shape.input
      .extend({
        presentationSpec: presentationSpecSchema,
        structuredContextHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export const generationRecordSchema = z.discriminatedUnion('schemaVersion', [
  generationRecordV1Schema,
  generationRecordV2Schema,
]);

/** Upgrades a supported record only when its source viewport makes presentation intent unambiguous. */
export function upgradeGenerationRecord(value: unknown): GenerationRecordV2 {
  const record = generationRecordSchema.parse(value);
  if (record.schemaVersion === '2.0') return record;
  const viewport =
    record.input.viewport ??
    record.viewports.find((item) => item.classification === 'source-fidelity')?.viewport;
  if (!viewport) {
    throw new Error(
      'Generation record 1.0 has no source viewport and cannot be upgraded safely. Re-run inspection to recover explicit presentation intent.',
    );
  }
  return generationRecordV2Schema.parse({
    ...record,
    schemaVersion: '2.0',
    input: {
      ...record.input,
      presentationSpec: intrinsicPresentationSpec(viewport),
      structuredContextHash: hashStructuredContext(emptyStructuredDesignContext()),
    },
  });
}

export type SvgGenerationInput = z.infer<typeof svgGenerationInputSchema>;
export type DesignBundleNode = z.infer<typeof designBundleNodeSchema>;
export type DesignBundle = z.infer<typeof designBundleSchema>;
export type DesignBundleV1 = z.infer<typeof designBundleV1Schema>;
export type DesignBundleV2 = z.infer<typeof designBundleV2Schema>;
export type GenerationDecision = z.infer<typeof generationDecisionSchema>;
export type GenerationUncertainty = z.infer<typeof generationUncertaintySchema>;
export type SanitizationSummary = z.infer<typeof sanitizationSummarySchema>;
export type GenerationMode = z.infer<typeof generationModeSchema>;
export type GenerationLayout = z.infer<typeof generationLayoutSchema>;
export type GenerationRecord = z.infer<typeof generationRecordSchema>;
export type GenerationRecordV2 = z.infer<typeof generationRecordV2Schema>;
export type GenerationStopReason = z.infer<typeof generationStopReasonSchema>;
export type StructuredDesignContext = z.infer<typeof structuredDesignContextSchema>;
export type PresentationSpec = z.infer<typeof presentationSpecSchema>;
