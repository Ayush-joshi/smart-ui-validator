#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  AgentMemoryProvider,
  HeuristicRepairProvider,
  HtmlReporter,
  LocalArtifactStore,
  LocalImageDesignProvider,
  LocalMemoryProvider,
  LocalPolicy,
  MockCodingProvider,
  PlaywrightBrowserProvider,
  ReactFrameworkAdapter,
  SmartUiError,
  SmartUiOrchestrator,
  compareImages,
  designContractSchema,
  loadConfig,
  runRecordSchema,
  resolveMemoryPath,
} from '@smart-ui/core';
import { registerMemoryCommands } from './memory-cli.js';

const program = new Command()
  .name('smart-ui')
  .description('Normalize, validate, and repair UI implementations with deterministic evidence')
  .version('0.3.0')
  .showSuggestionAfterError();

const invocationRoot = process.env['INIT_CWD'] ?? process.cwd();

registerMemoryCommands(program, invocationRoot);

program
  .command('inspect')
  .requiredOption('--target <path>', 'React repository root')
  .option('--json', 'emit JSON')
  .action(async ({ target, json }: { target: string; json?: boolean }) => {
    print(await new ReactFrameworkAdapter().inspect(userPath(target)), json);
  });

const design = program.command('design').description('Design evidence operations');
design
  .command('normalize')
  .requiredOption('--image <path>', 'local PNG, JPEG, WebP, or SVG reference')
  .option('--spec <path>', 'optional JSON sidecar with explicit element evidence')
  .option('--out <path>', 'contract output', 'design-contract.json')
  .option('--artifacts <path>', 'artifact directory', '.smart-ui/artifacts')
  .option('--json', 'emit JSON')
  .action(async (options: NormalizeOptions) => {
    const store = new LocalArtifactStore(userPath(options.artifacts));
    const spec = options.spec
      ? JSON.parse(await readFile(userPath(options.spec), 'utf8'))
      : undefined;
    const contract = await new LocalImageDesignProvider(store).normalize({
      imagePath: userPath(options.image),
      ...(spec === undefined ? {} : { spec }),
    });
    await writeFile(userPath(options.out), `${JSON.stringify(contract, null, 2)}\n`);
    print(contract, options.json);
  });

addRunCommand('run', 'Backward-compatible alias for fix');
addRunCommand('fix', 'Validate and apply bounded repairs');

program
  .command('validate')
  .description('Capture and score once without proposing source changes')
  .requiredOption('--target <path>', 'React repository root')
  .requiredOption('--design <path>', 'DesignContract JSON file')
  .requiredOption('--route <url>', 'fully qualified fixture URL')
  .option('--artifacts <path>', 'artifact directory (defaults under target)')
  .option('--json', 'emit JSON')
  .action(async (options: ValidateCliOptions) => {
    const result = await execute(options, false);
    print(result, options.json);
    if (result.record.status === 'failed') process.exitCode = 4;
    else if (hasBlockingFindings(result.record)) process.exitCode = 3;
  });

program
  .command('compare')
  .description('Compare two image artifacts directly')
  .argument('<target-image>', 'PNG, JPEG, WebP, or SVG target image')
  .argument('<implementation-image>', 'PNG, JPEG, WebP, or SVG implementation image')
  .option('--out <path>', 'output diff path', 'diff.png')
  .option('--overlay <path>', 'output overlay path', 'overlay.png')
  .option('--json', 'emit JSON')
  .action(async (targetPath: string, implementationPath: string, options: CompareOptions) => {
    const target = userPath(targetPath);
    const implementation = userPath(implementationPath);
    const result = await compareImages(await readFile(target), await readFile(implementation), [], {
      mediaType1: mediaTypeFor(target),
      mediaType2: mediaTypeFor(implementation),
    });
    await writeFile(userPath(options.out), result.diff);
    await writeFile(userPath(options.overlay), result.overlay);
    print(
      { diffPercent: result.diffPercent, diff: options.out, overlay: options.overlay },
      options.json,
    );
    if (result.diffPercent > 0) process.exitCode = 3;
  });

program
  .command('report')
  .argument('<run-record>', 'RunRecord JSON path')
  .addOption(new Option('--format <format>').choices(['html', 'json']).default('html'))
  .option('--artifacts <path>', 'artifact directory', '.smart-ui/artifacts')
  .option('--json', 'emit JSON')
  .action(async (recordPath: string, options: ReportOptions) => {
    const record = runRecordSchema.parse(JSON.parse(await readFile(userPath(recordPath), 'utf8')));
    if (options.format === 'json') {
      print(record, true);
      return;
    }
    const report = await new HtmlReporter(
      new LocalArtifactStore(userPath(options.artifacts)),
    ).write(record);
    print(report, options.json);
  });

program.parseAsync().catch((error: unknown) => {
  const code = error instanceof SmartUiError ? error.code : 'UNEXPECTED';
  console.error(
    JSON.stringify({
      error: code,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = error instanceof SmartUiError && error.code === 'INVALID_INPUT' ? 2 : 1;
});

function addRunCommand(name: string, description: string): void {
  program
    .command(name)
    .description(description)
    .requiredOption('--target <path>', 'React repository root')
    .requiredOption('--design <path>', 'DesignContract JSON file')
    .requiredOption('--route <url>', 'fully qualified fixture URL')
    .option('--artifacts <path>', 'artifact directory (defaults under target)')
    .option('--allow-write <path...>', 'additional exact target-relative writable files', [])
    .option('--max-passes <count>', 'maximum repair patches for this run', parsePassCount)
    .option('--dry-run', 'record one proposed patch without source writes')
    .option('--memory', 'enable scoped advisory memory recall')
    .option('--tenant <id>', 'explicit tenant identity', 'local')
    .option('--user <id>', 'explicit user identity', 'default')
    .option('--project <id>', 'project identity')
    .option('--component <id>', 'component identity')
    .option('--session <id>', 'session identity')
    .option('--json', 'emit JSON')
    .action(async (options: RunCliOptions) => {
      const result = await execute(options, true);
      print(result, options.json);
      if (result.record.status === 'failed') process.exitCode = 4;
      else if (hasBlockingFindings(result.record)) process.exitCode = 3;
    });
}

async function execute(
  options: RunCliOptions | ValidateCliOptions,
  repairEnabled: boolean,
): Promise<Awaited<ReturnType<SmartUiOrchestrator['run']>>> {
  const target = userPath(options.target);
  const config = await loadConfig(target);
  const artifactRoot = options.artifacts
    ? userPath(options.artifacts)
    : join(target, '.smart-ui', 'artifacts');
  const store = new LocalArtifactStore(artifactRoot);
  const contract = designContractSchema.parse(
    JSON.parse(await readFile(userPath(options.design), 'utf8')),
  );
  const routeOrigin = new URL(options.route).origin;
  const additionalWrites = 'allowWrite' in options ? options.allowWrite : [];
  const policy = new LocalPolicy({
    targetRoot: target,
    writableFiles: [...new Set([...config.policy.allowedPaths, ...additionalWrites])],
    allowedCommands: config.policy.allowedCommands,
    allowedEndpoints: [...new Set([routeOrigin, ...config.policy.endpointAllowlist])],
    dryRun: 'dryRun' in options ? (options.dryRun ?? false) : false,
    maxExecutionTimeMs: 60_000,
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const memoryEnabled = 'memory' in options && (options.memory ?? config.memory.enabled);
    const localMemory = memoryEnabled
      ? new LocalMemoryProvider(resolveMemoryPath(target, config.memory.storePath))
      : undefined;
    const memoryProvider =
      localMemory && config.memory.backend === 'agent-memory'
        ? new AgentMemoryProvider(localMemory, {
            databasePath: resolveMemoryPath(target, config.memory.agentMemoryDatabasePath),
          })
        : localMemory;
    return await new SmartUiOrchestrator({
      framework: new ReactFrameworkAdapter(),
      coding: new MockCodingProvider(),
      repair: new HeuristicRepairProvider(),
      browser: new PlaywrightBrowserProvider(),
      artifacts: store,
      policy,
      reporter: new HtmlReporter(store),
      ...(memoryProvider ? { memory: memoryProvider } : {}),
    }).run({
      targetRoot: target,
      designContractPath: userPath(options.design),
      contract,
      url: options.route,
      repairEnabled,
      ...(memoryEnabled
        ? {
            memoryContext: {
              tenantId: 'tenant' in options ? options.tenant : 'local',
              userId: 'user' in options ? options.user : 'default',
              repositoryId: target,
              ...('project' in options && options.project ? { projectId: options.project } : {}),
              ...('component' in options && options.component
                ? { componentId: options.component }
                : {}),
              ...('session' in options && options.session ? { sessionId: options.session } : {}),
            },
          }
        : {}),
      ...('maxPasses' in options && options.maxPasses !== undefined
        ? { maxRepairPasses: options.maxPasses }
        : {}),
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

function hasBlockingFindings(record: {
  passes: Array<{ findings: Array<{ severity: string }> }>;
}): boolean {
  return record.passes.at(-1)?.findings.some((finding) => finding.severity === 'error') ?? false;
}

function print(value: unknown, json?: boolean): void {
  console.log(json || typeof value !== 'string' ? JSON.stringify(value, null, 2) : value);
}

function userPath(path: string): string {
  return resolve(invocationRoot, path);
}

function parsePassCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 20) {
    throw new SmartUiError('INVALID_INPUT', '--max-passes must be an integer from 0 to 20.');
  }
  return parsed;
}

function mediaTypeFor(path: string): string {
  const type = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }[extname(path).toLowerCase()];
  if (!type) throw new SmartUiError('INVALID_INPUT', `Unsupported image format: ${extname(path)}`);
  return type;
}

interface NormalizeOptions {
  image: string;
  spec?: string;
  out: string;
  artifacts: string;
  json?: boolean;
}

interface RunCliOptions {
  target: string;
  design: string;
  route: string;
  artifacts?: string;
  allowWrite: string[];
  maxPasses?: number;
  dryRun?: boolean;
  json?: boolean;
  memory?: boolean;
  tenant: string;
  user: string;
  project?: string;
  component?: string;
  session?: string;
}

interface ValidateCliOptions {
  target: string;
  design: string;
  route: string;
  artifacts?: string;
  json?: boolean;
}

interface CompareOptions {
  out: string;
  overlay: string;
  json?: boolean;
}

interface ReportOptions {
  format: 'html' | 'json';
  artifacts: string;
  json?: boolean;
}
