#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  AgentMemoryProvider,
  AutoFrameworkAdapter,
  FileAuditLog,
  HeuristicRepairProvider,
  HtmlGenerationReporter,
  HtmlReporter,
  DeterministicHtmlGenerationProvider,
  GenerationOrchestrator,
  LocalArtifactStore,
  LocalImageDesignProvider,
  LocalMemoryProvider,
  LocalBaselineStore,
  LocalPolicy,
  LocalSvgStructureProvider,
  LoopbackGeneratedPreviewProvider,
  MockCodingProvider,
  PlaywrightBrowserProvider,
  ReproducibleGenerationExporter,
  SmartUiError,
  SmartUiOrchestrator,
  compareImages,
  designContractSchema,
  evaluateRelease,
  loadConfig,
  runRecordSchema,
  resolveMemoryPath,
  runDoctor,
  runSetup,
} from 'smart-ui-validator-core';
import { registerMemoryCommands } from './memory-cli.js';

const program = new Command()
  .name('smart-ui')
  .description('Normalize, validate, and repair UI implementations with deterministic evidence')
  .version('0.4.2')
  .showSuggestionAfterError();

const invocationRoot = process.env['INIT_CWD'] ?? process.cwd();

registerMemoryCommands(program, invocationRoot);

program
  .command('generate')
  .description('Generate offline standalone HTML and CSS from a local SVG')
  .requiredOption('--workspace <path>', 'exact workspace and containment boundary')
  .requiredOption('--design <path>', 'local SVG inside the workspace')
  .option('--output <path>', 'materialize accepted files into this new empty directory')
  .option('--artifacts <path>', 'artifact base inside the workspace')
  .addOption(new Option('--mode <mode>').choices(['exact', 'hybrid', 'semantic']).default('hybrid'))
  .addOption(
    new Option('--layout <layout>')
      .choices(['fixed', 'responsive', 'component'])
      .default('responsive'),
  )
  .option('--name <name>', 'friendly generated UI name')
  .option('--instructions <text>', 'bounded implementation note')
  .option('--viewport <width>x<height>', 'explicit source viewport', parseGenerationViewport)
  .option('--timeout <milliseconds>', 'generation timeout', parseGenerationTimeout)
  .option(
    '--max-passes <count>',
    'maximum bounded generation revisions (0 or 1)',
    parseGenerationPassCount,
  )
  .option('--dry-run', 'inspect SVG safety and capability without a generated deliverable')
  .option('--json', 'emit one compact JSON result')
  .action(async (options: GenerateCliOptions) => {
    const workspace = userPath(options.workspace);
    const config = await loadConfig(workspace);
    const artifactBase = options.artifacts
      ? userPath(options.artifacts)
      : resolve(workspace, config.generation.artifactBase);
    const runRoot = join(artifactBase, `generation-${Date.now()}-${randomUUID()}`);
    const store = new LocalArtifactStore(runRoot);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    try {
      const result = await new GenerationOrchestrator({
        structure: new LocalSvgStructureProvider(store, config.generation.limits),
        generator: new DeterministicHtmlGenerationProvider(),
        preview: new LoopbackGeneratedPreviewProvider(),
        browser: new PlaywrightBrowserProvider(),
        artifacts: store,
        reporter: new HtmlGenerationReporter(store),
        exporter: new ReproducibleGenerationExporter(workspace),
        config,
      }).run(
        {
          workspaceRoot: workspace,
          svgPath: userPath(options.design),
          artifactRoot: runRoot,
          ...(options.output ? { exportRoot: userPath(options.output) } : {}),
          ...(options.name ? { name: options.name } : {}),
          mode: options.mode,
          layout: options.layout,
          ...(options.instructions ? { instructions: options.instructions } : {}),
          ...(options.viewport ? { viewport: options.viewport } : {}),
          rendering: {
            background: { kind: 'transparent' },
            locale: 'en-US',
            theme: 'light',
          },
          dryRun: options.dryRun ?? false,
          ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
          ...(options.maxPasses !== undefined ? { maxPasses: options.maxPasses } : {}),
        },
        controller.signal,
      );
      const summary = generationSummary(result, runRoot);
      if (options.json) console.log(JSON.stringify(summary));
      else printGenerationSummary(summary);
      process.exitCode = generationExitCode(result.record);
    } finally {
      process.removeListener('SIGINT', cancel);
    }
  });

program
  .command('inspect')
  .requiredOption('--target <path>', 'React or Angular repository root')
  .option('--json', 'emit JSON')
  .action(async ({ target, json }: { target: string; json?: boolean }) => {
    print(await new AutoFrameworkAdapter().inspect(userPath(target)), json);
  });

program
  .command('setup')
  .description('Install pinned local runtime assets and verify this project from scratch')
  .option('--target <path>', 'React or Angular repository root', '.')
  .option('--agent-memory', 'run a disposable embedded SQLite persistence canary')
  .option('--json', 'emit JSON and suppress installer progress')
  .action(
    async ({
      target,
      agentMemory,
      json,
    }: {
      target: string;
      agentMemory?: boolean;
      json?: boolean;
    }) => {
      const result = await runSetup(userPath(target), {
        verifyAgentMemory: agentMemory ?? false,
        ...(!json ? { onBrowserInstallOutput: (text: string) => process.stderr.write(text) } : {}),
      });
      print(result, json);
      if (!result.ready) process.exitCode = 4;
    },
  );

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
  .option('--memory', 'enable scoped advisory memory recall')
  .option('--tenant <id>', 'explicit tenant identity', 'local')
  .option('--user <id>', 'explicit user identity', 'default')
  .option('--project <id>', 'project identity')
  .option('--component <id>', 'component identity')
  .option('--session <id>', 'session identity')
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
  .option('--memory', 'enable scoped advisory memory recall')
  .option('--tenant <id>', 'explicit tenant identity', 'local')
  .option('--user <id>', 'explicit user identity', 'default')
  .option('--project <id>', 'project identity')
  .option('--component <id>', 'component identity')
  .option('--session <id>', 'session identity')
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
            identity: {
              tenantId: 'tenant' in options ? options.tenant : 'local',
              userId: 'user' in options ? options.user : 'default',
            },
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

function parseGenerationPassCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1) {
    throw new SmartUiError('INVALID_INPUT', '--max-passes must be 0 or 1 for SVG generation.');
  }
  return parsed;
}

function parseGenerationTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300_000) {
    throw new SmartUiError('INVALID_INPUT', '--timeout must be from 1 to 300000 milliseconds.');
  }
  return parsed;
}

function parseGenerationViewport(value: string): {
  width: number;
  height: number;
  deviceScaleFactor: number;
} {
  const [rawWidth, rawHeight, ...rest] = value.toLowerCase().split('x');
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (
    rest.length > 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 10_000 ||
    height > 10_000
  ) {
    throw new SmartUiError(
      'INVALID_INPUT',
      '--viewport must use WIDTHxHEIGHT with values from 1 to 10000.',
    );
  }
  return { width, height, deviceScaleFactor: 1 };
}

function generationSummary(
  result: Awaited<ReturnType<GenerationOrchestrator['run']>>,
  artifactRoot: string,
) {
  const finalPass = result.record.passes.at(-1);
  return {
    generationId: result.record.id,
    status: result.record.status,
    stoppedReason: result.record.stoppedReason,
    requestedMode: result.record.input.requestedMode,
    finalMode: result.record.input.finalMode,
    files: result.record.generatedFiles.map((file) => ({
      relativePath: file.relativePath,
      hash: file.hash,
      byteLength: file.byteLength,
    })),
    sanitization: {
      accepted: result.record.sanitization.accepted,
      nodeCount: result.record.sanitization.nodeCount,
      rejectionCodes: result.record.sanitization.rejectionCodes,
      originalInputHash: result.record.originalInputHash,
      sanitizedHash: result.record.sanitizedHash,
    },
    uncertaintyCount: result.record.uncertainties.length,
    uncertainties: result.record.uncertainties.slice(0, 5),
    similarity: finalPass ? Math.max(0, 100 - finalPass.diffPercent) : undefined,
    diffPercent: finalPass?.diffPercent,
    viewports: result.record.viewports.map((item) => ({
      name: item.name,
      classification: item.classification,
      similarity: item.similarity,
      findingCount: item.findings.length,
    })),
    record: resolve(artifactRoot, result.recordArtifact.relativePath),
    report: result.record.report
      ? resolve(artifactRoot, result.record.report.relativePath)
      : undefined,
    archive: result.record.archive
      ? resolve(artifactRoot, result.record.archive.relativePath)
      : undefined,
    exportedFiles: result.exportedFiles,
    warnings: result.record.warnings,
    failures: result.record.failures,
  };
}

function printGenerationSummary(summary: ReturnType<typeof generationSummary>): void {
  console.log(`Generation ${summary.generationId}: ${summary.status} (${summary.stoppedReason})`);
  console.log(
    `Mode: ${summary.requestedMode}${summary.finalMode ? ` -> ${summary.finalMode}` : ''}`,
  );
  console.log(
    `Sanitization: ${summary.sanitization.accepted ? 'accepted' : 'rejected'} · ${summary.sanitization.nodeCount} nodes`,
  );
  console.log(`Original hash: ${summary.sanitization.originalInputHash}`);
  if (summary.sanitization.sanitizedHash) {
    console.log(`Sanitized hash: ${summary.sanitization.sanitizedHash}`);
  }
  if (summary.similarity !== undefined) {
    console.log(`Source visual similarity: ${summary.similarity.toFixed(3)}%`);
  }
  for (const file of summary.files)
    console.log(`File: ${file.relativePath} (${file.hash.slice(0, 19)})`);
  console.log(`Record: ${summary.record}`);
  if (summary.report) console.log(`Report: ${summary.report}`);
  if (summary.archive) console.log(`ZIP: ${summary.archive}`);
  if (summary.uncertaintyCount > 0) console.log(`Uncertainties: ${summary.uncertaintyCount}`);
  for (const warning of summary.warnings.slice(0, 10)) console.log(`Warning: ${warning}`);
  for (const failure of summary.failures)
    console.log(`Failure: ${failure.code}: ${failure.message}`);
}

function generationExitCode(record: {
  status: string;
  stoppedReason: string;
  warnings: string[];
}): number {
  if (record.stoppedReason === 'canceled') return 130;
  if (record.stoppedReason === 'unsafe-svg') return 6;
  if (record.stoppedReason === 'invalid-svg') return 2;
  if (record.stoppedReason === 'policy-violation') return 4;
  if (record.status === 'failed') return 5;
  if (record.status === 'completed-with-warnings' || record.warnings.length > 0) return 3;
  return 0;
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

interface GenerateCliOptions {
  workspace: string;
  design: string;
  output?: string;
  artifacts?: string;
  mode: 'exact' | 'hybrid';
  layout: 'fixed' | 'responsive' | 'component';
  name?: string;
  instructions?: string;
  viewport?: { width: number; height: number; deviceScaleFactor: number };
  timeout?: number;
  maxPasses?: number;
  dryRun?: boolean;
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
  memory?: boolean;
  tenant: string;
  user: string;
  project?: string;
  component?: string;
  session?: string;
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
