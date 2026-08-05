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
});

const runFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
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
});

export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type DesignContract = z.infer<typeof designContractSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
