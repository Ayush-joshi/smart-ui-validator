import { z } from 'zod';

const artifactRefSchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  relativePath: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
});

const provenanceSchema = z.object({
  provider: z.string().min(1),
  source: z.string().min(1),
  capturedAt: z.string().datetime(),
  sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

/** Schema for individual design elements extracted from design context. */
export const designElementSchema = z.object({
  validationId: z.string().optional(),
  selector: z.string().optional(),
  figmaNodeId: z.string().optional(),
  type: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  padding: z.object({
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
    left: z.number(),
  }).optional(),
  margin: z.object({
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
    left: z.number(),
  }).optional(),
  gap: z.number().optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderWidth: z.number().optional(),
  borderRadius: z.number().optional(),
  opacity: z.number().optional(),
  boxShadow: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.union([z.string(), z.number()]).optional(),
  lineHeight: z.union([z.string(), z.number()]).optional(),
  letterSpacing: z.union([z.string(), z.number()]).optional(),
  text: z.string().optional(),
  textWrap: z.boolean().optional(),
});

/** Schema for validation findings detailing visual or structural mismatches. */
export const validationFindingSchema = z.object({
  id: z.string(),
  category: z.enum(['geometry', 'typography', 'appearance', 'assets', 'raster', 'runtime', 'accessibility']),
  severity: z.enum(['error', 'warning', 'info']),
  confidence: z.number().min(0).max(1),
  designNodeId: z.string().optional(),
  targetDomLocator: z.string().optional(),
  expected: z.any().optional(),
  actual: z.any().optional(),
  delta: z.any().optional(),
  message: z.string(),
  suggestedRepairCategory: z.string().optional(),
});

/** Version 1 framework-neutral design evidence. */
export const designContractSchema = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive().default(1),
  }),
  theme: z.enum(['light', 'dark']).default('light'),
  locale: z.string().default('en-US'),
  component: z.object({
    name: z.string().min(1),
    route: z.string().default('/'),
    description: z.string().optional(),
  }),
  reference: artifactRefSchema,
  provenance: provenanceSchema,
  ambiguities: z.array(z.string()).default([]),
  elements: z.array(designElementSchema).default([]),
});

const runFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

export const passRecordSchema = z.object({
  passIndex: z.number().int().nonnegative(),
  findings: z.array(validationFindingSchema),
  score: z.number().min(0).max(100),
  changedFiles: z.array(z.string()),
  reverted: z.boolean().default(false),
  screenshot: artifactRefSchema.optional(),
  heatmap: artifactRefSchema.optional(),
  timingsMs: z.record(z.string(), z.number()),
  failures: z.array(runFailureSchema),
});

/** Version 1 immutable record of an orchestration attempt, including failures. */
export const runRecordSchema = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'dry-run']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  targetRoot: z.string().min(1),
  designContract: z.string().min(1),
  inputs: z.record(z.string(), z.string()),
  decisions: z.array(z.object({ kind: z.string(), message: z.string() })),
  artifacts: z.array(artifactRefSchema),
  changedFiles: z.array(z.string()),
  timingsMs: z.record(z.string(), z.number().nonnegative()),
  warnings: z.array(z.string()),
  failures: z.array(runFailureSchema),
  provenance: z.object({ tool: z.literal('smart-ui'), version: z.string() }),
  passes: z.array(passRecordSchema).default([]),
  score: z.number().min(0).max(100).optional(),
});

export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type DesignElement = z.infer<typeof designElementSchema>;
export type ValidationFinding = z.infer<typeof validationFindingSchema>;
export type PassRecord = z.infer<typeof passRecordSchema>;
export type DesignContract = z.infer<typeof designContractSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;

