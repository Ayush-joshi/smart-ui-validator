import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const configSchema = z.object({
  validation: z
    .object({
      geometryTolerancePx: z.number().default(2),
      colorDeltaE: z.number().default(2.5),
      visualDifferencePercent: z.number().default(0.75),
      textWrapMismatchAllowed: z.boolean().default(false),
      requireNoConsoleErrors: z.boolean().default(true),
      requireKeyboardNavigation: z.boolean().default(true),
      maxRepairPasses: z.number().int().positive().default(5),
    })
    .default({
      geometryTolerancePx: 2,
      colorDeltaE: 2.5,
      visualDifferencePercent: 0.75,
      textWrapMismatchAllowed: false,
      requireNoConsoleErrors: true,
      requireKeyboardNavigation: true,
      maxRepairPasses: 5,
    }),
  policy: z
    .object({
      allowedPaths: z.array(z.string()).default([]),
      allowedCommands: z.record(z.string(), z.array(z.string())).default({}),
      endpointAllowlist: z.array(z.string()).default([]),
    })
    .default({
      allowedPaths: [],
      allowedCommands: {},
      endpointAllowlist: [],
    }),
  commands: z
    .object({
      format: z.string().nullable().default(null),
      typecheck: z.string().nullable().default(null),
      test: z.string().nullable().default(null),
    })
    .default({
      format: null,
      typecheck: null,
      test: null,
    }),
  masks: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
    )
    .default([]),
});

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(targetRoot: string): Promise<Config> {
  const configPath = join(targetRoot, 'smart-ui.config.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return configSchema.parse(parsed);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'ENOENT') {
      return configSchema.parse({});
    }
    throw error;
  }
}
