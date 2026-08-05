import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const commandSpecSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();

const viewportSchema = z
  .object({
    name: z.string().min(1),
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
    deviceScaleFactor: z.number().positive().max(4).default(1),
  })
  .strict();

const maskSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

export const configSchema = z
  .object({
    validation: z
      .object({
        geometryTolerancePx: z.number().nonnegative().max(100).default(2),
        typographyTolerancePx: z.number().nonnegative().max(20).default(1),
        colorDeltaE: z.number().nonnegative().max(100).default(2.5),
        visualDifferencePercent: z.number().min(0).max(100).default(0.75),
        rasterChannelTolerance: z.number().int().min(0).max(255).default(10),
        textWrapMismatchAllowed: z.boolean().default(false),
        requireNoConsoleErrors: z.boolean().default(true),
        requireNoNetworkFailures: z.boolean().default(true),
        requireKeyboardNavigation: z.boolean().default(true),
        maxRepairPasses: z.number().int().min(0).max(20).default(5),
        minimumScoreImprovement: z.number().min(0).max(100).default(0.01),
      })
      .strict()
      .default({
        geometryTolerancePx: 2,
        typographyTolerancePx: 1,
        colorDeltaE: 2.5,
        visualDifferencePercent: 0.75,
        rasterChannelTolerance: 10,
        textWrapMismatchAllowed: false,
        requireNoConsoleErrors: true,
        requireNoNetworkFailures: true,
        requireKeyboardNavigation: true,
        maxRepairPasses: 5,
        minimumScoreImprovement: 0.01,
      }),
    evidence: z
      .object({
        maxElements: z.number().int().positive().max(20_000).default(2_000),
        maxTextLength: z.number().int().positive().max(100_000).default(4_000),
        maxConsoleMessages: z.number().int().nonnegative().max(10_000).default(200),
        maxFailedRequests: z.number().int().nonnegative().max(10_000).default(200),
        maxArtifactBytes: z.number().int().positive().max(100_000_000).default(20_000_000),
        maxDiagnosticCharacters: z.number().int().positive().max(1_000_000).default(80_000),
      })
      .strict()
      .default({
        maxElements: 2_000,
        maxTextLength: 4_000,
        maxConsoleMessages: 200,
        maxFailedRequests: 200,
        maxArtifactBytes: 20_000_000,
        maxDiagnosticCharacters: 80_000,
      }),
    policy: z
      .object({
        allowedPaths: z.array(z.string().min(1)).default([]),
        allowedCommands: z.array(commandSpecSchema).default([]),
        endpointAllowlist: z.array(z.string().url()).default([]),
        blockExternalNetwork: z.boolean().default(true),
      })
      .strict()
      .default({
        allowedPaths: [],
        allowedCommands: [],
        endpointAllowlist: [],
        blockExternalNetwork: true,
      }),
    commands: z
      .object({
        format: commandSpecSchema.nullable().default(null),
        typecheck: commandSpecSchema.nullable().default(null),
        test: commandSpecSchema.nullable().default(null),
      })
      .strict()
      .default({ format: null, typecheck: null, test: null }),
    viewports: z.array(viewportSchema).default([]),
    masks: z.array(maskSchema).default([]),
  })
  .strict();

export type CommandSpec = z.infer<typeof commandSpecSchema>;
export type Config = z.infer<typeof configSchema>;

export async function loadConfig(targetRoot: string): Promise<Config> {
  const configPath = join(targetRoot, 'smart-ui.config.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    return configSchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    if (isMissing(error)) return configSchema.parse({});
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
