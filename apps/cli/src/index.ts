#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  AgentMemoryProvider,
  AutoFrameworkAdapter,
  FileAuditLog,
  HeuristicRepairProvider,
  HtmlReporter,
  LocalArtifactStore,
  LocalImageDesignProvider,
  LocalMemoryProvider,
  LocalBaselineStore,
  LocalPolicy,
  MockCodingProvider,
  PlaywrightBrowserProvider,
  SmartUiError,
  SmartUiOrchestrator,
  compareImages,
  designContractSchema,
  evaluateRelease,
  loadConfig,
  runRecordSchema,
  resolveMemoryPath,
  runDoctor,
} from '@smart-ui/core';
import { registerMemoryCommands } from './memory-cli.js';

const program = new Command()
  .name('smart-ui')
  .description('Normalize, validate, and repair UI implementations with deterministic evidence')
  .version('0.4.0')
  .showSuggestionAfterError();

const invocationRoot = process.env['INIT_CWD'] ?? process.cwd();

registerMemoryCommands(program, invocationRoot);

program
  .command('inspect')
  .requiredOption('--target <path>', 'React or Angular repository root')
  .option('--json', 'emit JSON')
  .action(async ({ target, json }: { target: string; json?: boolean }) => {
    print(await new AutoFrameworkAdapter().inspect(userPath(target)), json);
  });

program
  .command('doctor')
  .description('Run redacted read-only environment and target diagnostics')
  .option('--target <path>', 'React or Angular repository root', '.')
  .option('--json', 'emit JSON')
  .action(async ({ target, json }: { target: string; json?: boolean }) => {
    const diagnosis = await runDoctor(userPath(target));
    print(diagnosis, json);
    if (!diagnosis.ready) process.exitCode = 4;
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
  .option('--out <path>', 'also write the RunRecord JSON to this path')
  .option(
    '--state <state>',
    'default, hover, focus, active, disabled, loading, empty, or error',
    'default',
  )
  .option('--selector <selector>', 'target selector for hover, focus, or active state')
  .option('--json', 'emit JSON')
  .action(async (options: ValidateCliOptions) => {
    const result = await execute(options, false);
    await writeJsonOutput(options.out, result.record);
    print(result, options.json);
    if (result.record.status === 'failed') process.exitCode = 4;
    else if (hasBlockingFindings(result.record)) process.exitCode = 3;
  });

program
  .command('validate-matrix')
  .description('Validate every configured viewport and interaction state sequentially')
  .requiredOption('--target <path>', 'React or Angular repository root')
  .requiredOption('--design <path>', 'DesignContract JSON file')
  .requiredOption('--route <url>', 'default fully qualified target URL')
  .option('--artifacts <path>', 'artifact directory (defaults under target)')
  .option('--out <path>', 'also write the matrix result JSON to this path')
  .option('--json', 'emit JSON')
  .action(async (options: ValidateCliOptions) => {
    const target = userPath(options.target);
    const config = await loadConfig(target);
    const contract = designContractSchema.parse(
      JSON.parse(await readFile(userPath(options.design), 'utf8')),
    );
    const viewports =
      config.viewports.length > 0 ? config.viewports : [{ name: 'design', ...contract.viewport }];
    const results = [];
    for (const viewport of viewports) {
      for (const state of config.states) {
        results.push({
          viewport: viewport.name,
          state: state.name,
          result: await execute(options, false, {
            viewport,
            state: state.name,
            ...(state.selector ? { selector: state.selector } : {}),
            ...(state.url ? { url: state.url } : {}),
          }),
        });
      }
    }
    const output = { schemaVersion: '1.0' as const, results };
    await writeJsonOutput(options.out, output);
    print(output, options.json);
    if (results.some((item) => item.result.record.status === 'failed')) process.exitCode = 4;
    else if (results.some((item) => hasBlockingFindings(item.result.record))) process.exitCode = 3;
  });

const baseline = program
  .command('baseline')
  .description('Explicit visual-regression baseline review');
baseline
  .command('review')
  .requiredOption('--target <path>')
  .requiredOption('--run <path>', 'RunRecord JSON containing a screenshot')
  .requiredOption('--tenant <id>')
  .requiredOption('--repository <id>')
  .requiredOption('--component <name>')
  .requiredOption('--viewport <name>')
  .option('--state <name>', 'interaction state', 'default')
  .option('--manifest <path>', 'target-relative baseline manifest', '.smart-ui/baselines.json')
  .option('--json')
  .action(async (options: BaselineOptions) => {
    const { store, identity, artifact } = await baselineInputs(options);
    print(await store.review(identity, artifact), options.json);
  });
baseline
  .command('approve')
  .requiredOption('--target <path>')
  .requiredOption('--run <path>', 'reviewed RunRecord JSON containing a screenshot')
  .requiredOption('--tenant <id>')
  .requiredOption('--repository <id>')
  .requiredOption('--component <name>')
  .requiredOption('--viewport <name>')
  .requiredOption('--actor <id>')
  .requiredOption('--reason <text>')
  .requiredOption('--approve', 'explicit human approval')
  .option('--state <name>', 'interaction state', 'default')
  .option('--manifest <path>', 'target-relative baseline manifest', '.smart-ui/baselines.json')
  .option('--json')
  .action(
    async (options: BaselineOptions & { actor: string; reason: string; approve: boolean }) => {
      const { store, identity, artifact } = await baselineInputs(options);
      print(
        await store.approve(identity, artifact, {
          approved: options.approve,
          actor: options.actor,
          reason: options.reason,
        }),
        options.json,
      );
    },
  );

program
  .command('audit-verify')
  .description('Verify the local tamper-evident audit hash chain')
  .requiredOption('--path <path>', 'audit JSONL path')
  .option('--json')
  .action(async ({ path, json }: { path: string; json?: boolean }) => {
    const verification = await new FileAuditLog(userPath(path)).verify();
    print(verification, json);
    if (!verification.valid) process.exitCode = 4;
  });

program
  .command('evaluate')
  .description('Generate and enforce the versioned release scorecard')
  .option('--corpus <path>', 'corpus JSON', 'evaluations/corpus.v1.json')
  .option('--observations <path>', 'observation JSON', 'evaluations/observations.v1.json')
  .option('--thresholds <path>', 'threshold JSON', 'evaluations/release-thresholds.v1.json')
  .option('--out <path>', 'scorecard JSON', 'evaluation-scorecard.json')
  .option('--json')
  .action(async (options: EvaluationOptions) => {
    const scorecard = evaluateRelease(
      JSON.parse(await readFile(userPath(options.corpus), 'utf8')),
      JSON.parse(await readFile(userPath(options.observations), 'utf8')),
      JSON.parse(await readFile(userPath(options.thresholds), 'utf8')),
    );
    await writeFile(userPath(options.out), `${JSON.stringify(scorecard, null, 2)}\n`);
    print(scorecard, options.json);
    if (!scorecard.passed) process.exitCode = 3;
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
    .option('--out <path>', 'also write the RunRecord JSON to this path')
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
      await writeJsonOutput(options.out, result.record);
      print(result, options.json);
      if (result.record.status === 'failed') process.exitCode = 4;
      else if (hasBlockingFindings(result.record)) process.exitCode = 3;
    });
}

async function execute(
  options: RunCliOptions | ValidateCliOptions,
  repairEnabled: boolean,
  matrix?: MatrixExecution,
): Promise<Awaited<ReturnType<SmartUiOrchestrator['run']>>> {
  const target = userPath(options.target);
  const config = await loadConfig(target);
  const artifactRoot = options.artifacts
    ? userPath(options.artifacts)
    : join(target, '.smart-ui', 'artifacts');
  const store = new LocalArtifactStore(artifactRoot);
  const baseContract = designContractSchema.parse(
    JSON.parse(await readFile(userPath(options.design), 'utf8')),
  );
  const contract = matrix?.viewport ? { ...baseContract, viewport: matrix.viewport } : baseContract;
  const route = matrix?.url ?? options.route;
  const routeOrigin = new URL(route).origin;
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
    const interactionSelector =
      matrix?.selector ?? ('selector' in options ? options.selector : undefined);
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
      framework: new AutoFrameworkAdapter(),
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
      url: route,
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
      interaction: {
        name: matrix?.state ?? ('state' in options ? options.state : 'default'),
        ...(interactionSelector ? { selector: interactionSelector } : {}),
      },
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

async function writeJsonOutput(path: string | undefined, value: unknown): Promise<void> {
  if (path) await writeFile(userPath(path), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
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
  out?: string;
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
  out?: string;
  json?: boolean;
  state: 'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'empty' | 'error';
  selector?: string;
}

interface MatrixExecution {
  viewport: { name: string; width: number; height: number; deviceScaleFactor: number };
  state: ValidateCliOptions['state'];
  selector?: string;
  url?: string;
}

interface BaselineOptions {
  target: string;
  run: string;
  tenant: string;
  repository: string;
  component: string;
  viewport: string;
  state: string;
  manifest: string;
  json?: boolean;
}

interface EvaluationOptions {
  corpus: string;
  observations: string;
  thresholds: string;
  out: string;
  json?: boolean;
}

async function baselineInputs(options: BaselineOptions) {
  const target = userPath(options.target);
  const record = runRecordSchema.parse(JSON.parse(await readFile(userPath(options.run), 'utf8')));
  const artifact = record.passes.at(-1)?.screenshot;
  if (!artifact)
    throw new SmartUiError('INVALID_INPUT', 'Run record has no implementation screenshot.');
  return {
    store: new LocalBaselineStore(resolve(target, options.manifest)),
    identity: {
      tenantId: options.tenant,
      repositoryId: options.repository,
      component: options.component,
      viewport: options.viewport,
      state: options.state,
    },
    artifact,
  };
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
