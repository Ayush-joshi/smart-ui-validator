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
    schemaVersion: z.literal('1.0').default('1.0'),
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
        requireAccessibleNames: z.boolean().default(true),
        minimumContrastRatio: z.number().min(1).max(21).default(4.5),
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
        requireAccessibleNames: true,
        minimumContrastRatio: 4.5,
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
    generation: z
      .object({
        artifactBase: z.string().min(1).default('.smart-ui/generations'),
        timeoutMs: z.number().int().positive().max(300_000).default(60_000),
        maxPasses: z.number().int().min(0).max(1).default(1),
        maxProposalRegressionPercent: z.number().min(0).max(100).default(0),
        narrowViewportWidth: z.number().int().positive().max(2_000).default(375),
        limits: z
          .object({
            maxSvgBytes: z.number().int().positive().max(50_000_000).default(5_000_000),
            maxDecodedCharacters: z.number().int().positive().max(50_000_000).default(5_000_000),
            maxNodes: z.number().int().positive().max(100_000).default(10_000),
            maxDepth: z.number().int().positive().max(256).default(64),
            maxAttributes: z.number().int().positive().max(500_000).default(50_000),
            maxPathDataCharacters: z
              .number()
              .int()
              .nonnegative()
              .max(20_000_000)
              .default(2_000_000),
            maxGradients: z.number().int().nonnegative().max(10_000).default(1_000),
            maxFilters: z.number().int().nonnegative().max(1_000).default(100),
            maxEmbeddedImages: z.number().int().nonnegative().max(1_000).default(100),
            maxEmbeddedImageBytes: z
              .number()
              .int()
              .nonnegative()
              .max(20_000_000)
              .default(2_000_000),
            maxGeneratedFiles: z.number().int().positive().max(1_000).default(100),
            maxGeneratedFileBytes: z.number().int().positive().max(50_000_000).default(10_000_000),
            maxTotalOutputBytes: z.number().int().positive().max(100_000_000).default(20_000_000),
          })
          .strict()
          .default({
            maxSvgBytes: 5_000_000,
            maxDecodedCharacters: 5_000_000,
            maxNodes: 10_000,
            maxDepth: 64,
            maxAttributes: 50_000,
            maxPathDataCharacters: 2_000_000,
            maxGradients: 1_000,
            maxFilters: 100,
            maxEmbeddedImages: 100,
            maxEmbeddedImageBytes: 2_000_000,
            maxGeneratedFiles: 100,
            maxGeneratedFileBytes: 10_000_000,
            maxTotalOutputBytes: 20_000_000,
          }),
      })
      .strict()
      .default({
        artifactBase: '.smart-ui/generations',
        timeoutMs: 60_000,
        maxPasses: 1,
        maxProposalRegressionPercent: 0,
        narrowViewportWidth: 375,
        limits: {
          maxSvgBytes: 5_000_000,
          maxDecodedCharacters: 5_000_000,
          maxNodes: 10_000,
          maxDepth: 64,
          maxAttributes: 50_000,
          maxPathDataCharacters: 2_000_000,
          maxGradients: 1_000,
          maxFilters: 100,
          maxEmbeddedImages: 100,
          maxEmbeddedImageBytes: 2_000_000,
          maxGeneratedFiles: 100,
          maxGeneratedFileBytes: 10_000_000,
          maxTotalOutputBytes: 20_000_000,
        },
      }),
    memory: z
      .object({
        enabled: z.boolean().default(false),
        learningEnabled: z.boolean().default(false),
        backend: z.enum(['local', 'agent-memory']).default('local'),
        storePath: z.string().min(1).default('.smart-ui/memory.json'),
        agentMemoryDatabasePath: z.string().min(1).default('.smart-ui/agent-memory.sqlite'),
        maxRecords: z.number().int().positive().max(100).default(12),
        maxCharactersPerMemory: z.number().int().positive().max(8_000).default(800),
        maxTotalCharacters: z.number().int().positive().max(50_000).default(6_000),
        telemetryEnabled: z.boolean().default(false),
        remoteBackendEnabled: z.boolean().default(false),
      })
      .strict()
      .default({
        enabled: false,
        learningEnabled: false,
        backend: 'local',
        storePath: '.smart-ui/memory.json',
        agentMemoryDatabasePath: '.smart-ui/agent-memory.sqlite',
        maxRecords: 12,
        maxCharactersPerMemory: 800,
        maxTotalCharacters: 6_000,
        telemetryEnabled: false,
        remoteBackendEnabled: false,
      }),
    enterprise: z
      .object({
        enabled: z.boolean().default(false),
        requireAuthenticatedIdentity: z.boolean().default(true),
        encryptionAtRestRequired: z.boolean().default(false),
        auditLogPath: z.string().min(1).default('.smart-ui/audit/events.jsonl'),
        telemetryEnabled: z.boolean().default(false),
        remoteMcpEnabled: z.boolean().default(false),
        channelIntegrationsEnabled: z.boolean().default(false),
        retentionDays: z
          .object({
            artifacts: z.number().int().positive().max(3_650).default(30),
            reports: z.number().int().positive().max(3_650).default(90),
            audit: z.number().int().positive().max(3_650).default(365),
            memory: z.number().int().positive().max(3_650).default(365),
          })
          .strict()
          .default({ artifacts: 30, reports: 90, audit: 365, memory: 365 }),
        adminPolicy: z
          .object({
            allowedMemoryScopes: z
              .array(
                z.enum([
                  'organization',
                  'team',
                  'user',
                  'repository',
                  'project',
                  'component',
                  'session',
                  'task',
                ]),
              )
              .default(['user', 'repository', 'project', 'component', 'session', 'task']),
            learningEnabled: z.boolean().default(false),
            remoteDesignAccessEnabled: z.boolean().default(false),
            externalModelProviders: z.array(z.string().min(1)).default([]),
            browserNetworkEnabled: z.boolean().default(false),
            channelOutputEnabled: z.boolean().default(false),
          })
          .strict()
          .default({
            allowedMemoryScopes: ['user', 'repository', 'project', 'component', 'session', 'task'],
            learningEnabled: false,
            remoteDesignAccessEnabled: false,
            externalModelProviders: [],
            browserNetworkEnabled: false,
            channelOutputEnabled: false,
          }),
      })
      .strict()
      .default({
        enabled: false,
        requireAuthenticatedIdentity: true,
        encryptionAtRestRequired: false,
        auditLogPath: '.smart-ui/audit/events.jsonl',
        telemetryEnabled: false,
        remoteMcpEnabled: false,
        channelIntegrationsEnabled: false,
        retentionDays: { artifacts: 30, reports: 90, audit: 365, memory: 365 },
        adminPolicy: {
          allowedMemoryScopes: ['user', 'repository', 'project', 'component', 'session', 'task'],
          learningEnabled: false,
          remoteDesignAccessEnabled: false,
          externalModelProviders: [],
          browserNetworkEnabled: false,
          channelOutputEnabled: false,
        },
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
    states: z
      .array(
        z
          .object({
            name: z.enum([
              'default',
              'hover',
              'focus',
              'active',
              'disabled',
              'loading',
              'empty',
              'error',
            ]),
            selector: z.string().min(1).optional(),
            url: z.string().url().optional(),
          })
          .strict(),
      )
      .default([{ name: 'default' }]),
    dynamicRegions: z
      .array(z.object({ selector: z.string().min(1), reason: z.string().min(1).max(500) }).strict())
      .default([]),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [index, state] of config.states.entries()) {
      if (['hover', 'focus', 'active'].includes(state.name) && !state.selector) {
        context.addIssue({
          code: 'custom',
          path: ['states', index, 'selector'],
          message: `State '${state.name}' requires a selector.`,
        });
      }
    }
    if (
      config.enterprise.remoteMcpEnabled &&
      (!config.enterprise.enabled ||
        !config.enterprise.requireAuthenticatedIdentity ||
        !config.enterprise.encryptionAtRestRequired)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['enterprise', 'remoteMcpEnabled'],
        message:
          'Remote MCP requires enterprise mode, authenticated identity, and encryption-at-rest policy.',
      });
    }
    if (
      config.enterprise.enabled &&
      !config.enterprise.adminPolicy.browserNetworkEnabled &&
      !config.policy.blockExternalNetwork
    ) {
      context.addIssue({
        code: 'custom',
        path: ['policy', 'blockExternalNetwork'],
        message: 'Administrative policy does not permit browser networking.',
      });
    }
    if (
      config.enterprise.enabled &&
      !config.enterprise.adminPolicy.learningEnabled &&
      config.memory.learningEnabled
    ) {
      context.addIssue({
        code: 'custom',
        path: ['memory', 'learningEnabled'],
        message: 'Administrative policy does not permit learning.',
      });
    }
  });

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
