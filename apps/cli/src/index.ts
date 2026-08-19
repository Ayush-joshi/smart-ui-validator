#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  ensureStudioAgentHostConfig,
  installPlaywrightChromium,
  generationDesignContextSchema,
  presentationSpecSchema,
  readImageDimensions,
  redactSensitiveValue,
  svgGenerationInputSchema,
  structuredDesignContextSchema,
  runStudioAgentSetupChecks,
  type StudioAgentHost,
  type PresentationSpec,
  type StructuredDesignContext,
} from 'smart-ui-validator-core';
import { registerMemoryCommands } from './memory-cli.js';
import { registerHandoffCommands } from './handoff-cli.js';
import { loadStudioModule } from './studio-loader.js';

const program = new Command()
  .name('smart-ui')
  .description('Normalize, validate, and repair UI implementations with deterministic evidence')
  .version('0.4.2')
  .showSuggestionAfterError();

const invocationRoot = process.env['INIT_CWD'] ?? process.cwd();

registerMemoryCommands(program, invocationRoot);

registerHandoffCommands(program, {
  invocationRoot,
  print,
  userPath,
  openStudioReview: async (taskFile) => {
    const studio = await loadStudioModule();
    const workspace = userPath('.studio-workspace');
    await studio.initializeStudioWorkspace(workspace);
    const server = await studio.startStudioServer({
      workspaceRoot: workspace,
      port: 0,
      reviewTask: taskFile,
    });
    console.log(`Studio review: ${server.url}`);
    openBrowser(server.url);
    await waitForStudioShutdown(server);
  },
});

program
  .command('studio')
  .description('Launch the local-only SVG generation Studio on an isolated loopback origin')
  .option(
    '--workspace <path>',
    'dedicated Studio workspace (defaults to <cwd>/.studio-workspace, kept inside the MCP root)',
  )
  .option('--init', 'initialize an empty dedicated workspace before startup')
  .option('--init-only', 'initialize the workspace and exit without starting the server')
  .option('--open', 'open the exact loopback URL in the system browser')
  .option('--target <path>', 'absolute repository root enabling the validate-UI work type')
  .option('--review-task <path>', 'verified handoff task.json to import and open for review')
  .option('--port <port>', 'exact loopback port (0 chooses an ephemeral port)', parseStudioPort, 0)
  .option(
    '--retention-hours <hours>',
    'expire completed local runs after this many hours',
    parseStudioRetentionHours,
    24,
  )
  .option('--health-check', 'start, report all Studio health checks, and exit')
  .option('--agent', 'bootstrap and verify the Studio plus MCP-agent workflow')
  .addOption(new Option('--host <host>').choices(['codex', 'claude', 'copilot']).default('codex'))
  .option('--check-only', 'run setup checks without writing config or starting Studio')
  .option('--dry-run', 'preview agent setup without writing config or starting Studio')
  .option('--ensure-engine', 'explicitly install pinned Chromium and rebuild stale local assets')
  .option('--json', 'emit one compact startup or initialization result')
  .action(async (options: StudioCliOptions) => {
    const workspace = userPath(options.workspace ?? '.studio-workspace');
    const studio = await loadStudioModule();
    if (options.agent) {
      const runtime = studioAgentRuntime();
      const mcpRoot = resolve(process.env['SMART_UI_MCP_ROOT'] ?? invocationRoot);
      const hostConfigPath = studioAgentHostConfigPath(options.host);
      const expectedHostConfig = studioAgentHostConfig(options.host, runtime.mcpEntryPath, mcpRoot);
      if (options.ensureEngine) {
        const installed = await installPlaywrightChromium(invocationRoot);
        if (installed.exitCode !== 0) {
          throw new SmartUiError(
            'PROVIDER_FAILURE',
            installed.stderr || installed.stdout || 'Pinned Chromium installation failed.',
          );
        }
        if (runtime.sourcePaths) await runExplicitProcess('pnpm', ['build'], invocationRoot);
      }
      const configAction =
        options.checkOnly || options.dryRun
          ? await ensureStudioAgentHostConfig(hostConfigPath, expectedHostConfig, true)
          : await ensureStudioAgentHostConfig(hostConfigPath, expectedHostConfig);
      if (!options.checkOnly && !options.dryRun) await studio.initializeStudioWorkspace(workspace);
      const setup = await runStudioAgentSetupChecks({
        workspaceRoot: workspace,
        mcpRoot,
        mcpEntryPath: runtime.mcpEntryPath,
        studioAssetsRoot: runtime.studioAssetsRoot,
        host: options.host,
        hostConfigPath,
        expectedHostConfig,
        ...(runtime.sourcePaths ? { sourcePaths: runtime.sourcePaths } : {}),
        ...(runtime.studioSourcePaths ? { studioSourcePaths: runtime.studioSourcePaths } : {}),
      });
      const bootstrap = {
        schemaVersion: '1.0',
        ready: setup.ready && (configAction === 'created' || configAction === 'unchanged'),
        dryRun: options.dryRun ?? false,
        checkOnly: options.checkOnly ?? false,
        host: options.host,
        workspace,
        mcpRoot,
        mcpEntry: runtime.mcpEntryPath,
        hostConfigPath,
        configAction,
        checks: setup.checks,
        restartAction: studioAgentRestartAction(options.host),
        firstRequest: `Use the smart-ui MCP server. Call list_studio_authoring_requests with studioWorkspace ${JSON.stringify(workspace)} and author the pending exact run and round.`,
      };
      if (options.checkOnly || options.dryRun || !bootstrap.ready) {
        print(bootstrap, options.json);
        if (!bootstrap.ready) process.exitCode = 4;
        return;
      }
    }
    // The dedicated workspace is always initialized (idempotently) so the agent-powered flow works
    // with zero setup; the MCP-connected agent reaches its queue inside this in-repo workspace.
    const initialized = await studio.initializeStudioWorkspace(workspace);
    if (options.initOnly) {
      print(initialized, options.json);
      return;
    }
    const server = await studio.startStudioServer({
      workspaceRoot: workspace,
      port: options.port,
      retentionMs: options.retentionHours * 60 * 60 * 1_000,
      ...(options.target ? { targetRoot: userPath(options.target) } : {}),
      ...(options.reviewTask ? { reviewTask: userPath(options.reviewTask) } : {}),
    });
    const health = await server.health();
    const result = {
      url: server.url,
      workspace: server.workspaceRoot,
      health,
      localOnly: true,
      telemetry: false,
    };
    print(result, options.json);
    if (options.healthCheck) {
      await server.close();
      if (health.status !== 'ready') process.exitCode = 4;
      return;
    }
    if (options.open) openBrowser(server.url);
    await waitForStudioShutdown(server);
  });

program
  .command('generate')
  .description('Generate offline standalone HTML and CSS from a local SVG or PNG')
  .requiredOption('--workspace <path>', 'exact workspace and containment boundary')
  .requiredOption('--design <path>', 'local SVG or PNG inside the workspace')
  .option('--output <path>', 'materialize accepted files into this new empty directory')
  .option('--artifacts <path>', 'artifact base inside the workspace')
  .addOption(
    new Option('--engine <engine>').choices(['deterministic', 'agent']).default('deterministic'),
  )
  .addOption(new Option('--mode <mode>').choices(['exact', 'hybrid', 'semantic']).default('hybrid'))
  .addOption(
    new Option('--layout <layout>')
      .choices(['fixed', 'responsive', 'component'])
      .default('responsive'),
  )
  .option('--name <name>', 'friendly generated UI name')
  .option('--instructions <text>', 'bounded implementation note')
  .option(
    '--design-context <path>',
    'optional bounded UTF-8 source context (JSX, TSX, HTML, CSS, JSON, Markdown, or text)',
  )
  .option('--structured-context <path>', 'StructuredDesignContext 1.0 JSON inside the workspace')
  .option('--presentation <path>', 'PresentationSpec 1.0 JSON inside the workspace')
  .option('--viewport <width>x<height>', 'explicit source viewport', parseGenerationViewport)
  .option('--timeout <milliseconds>', 'generation timeout', parseGenerationTimeout)
  .option(
    '--max-passes <count>',
    'maximum bounded generation revisions (0 or 1)',
    parseGenerationPassCount,
  )
  .option('--dry-run', 'inspect design safety and capability without a generated deliverable')
  .option('--json', 'emit one compact JSON result')
  .action(async (options: GenerateCliOptions) => {
    if (options.engine === 'agent') {
      throw new SmartUiError(
        'INVALID_INPUT',
        '`smart-ui generate --engine agent` was removed. Use `smart-ui generation prepare --workspace <path> --design <path>` and review the persistent task instead.',
      );
    }
    const workspace = userPath(options.workspace);
    const config = await loadConfig(workspace);
    const artifactBase = options.artifacts
      ? userPath(options.artifacts)
      : resolve(workspace, config.generation.artifactBase);
    const runRoot = join(artifactBase, `generation-${Date.now()}-${randomUUID()}`);
    const store = new LocalArtifactStore(runRoot);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let stagingPath: string | undefined;
    process.once('SIGINT', cancel);
    try {
      const contexts = await readCliDesignContexts(workspace, options);
      const structuredDesignContext = contexts.structuredDesignContext;
      const presentationSpec = options.presentation
        ? presentationSpecSchema.parse(
            JSON.parse(
              await readFile(
                containedUserPath(workspace, options.presentation, 'presentation spec'),
                'utf8',
              ),
            ),
          )
        : undefined;
      const preparedDesign = await prepareCliGenerationDesign(
        workspace,
        containedUserPath(workspace, options.design, 'design reference'),
        config.generation.limits,
      );
      stagingPath = preparedDesign.stagingPath;
      const generationInput = svgGenerationInputSchema.parse({
        workspaceRoot: workspace,
        svgPath: preparedDesign.svgPath,
        artifactRoot: runRoot,
        ...(options.output ? { exportRoot: userPath(options.output) } : {}),
        name: options.name ?? preparedDesign.name,
        mode: options.mode,
        layout: options.layout,
        ...(options.instructions ? { instructions: options.instructions } : {}),
        ...(contexts.designContext ? { designContext: contexts.designContext } : {}),
        ...(preparedDesign.designReference
          ? { designReference: preparedDesign.designReference }
          : {}),
        ...(structuredDesignContext ? { structuredDesignContext } : {}),
        ...(presentationSpec ? { presentationSpec } : {}),
        ...(options.viewport ? { viewport: options.viewport } : {}),
        rendering: {
          background: { kind: 'transparent' },
          locale: 'en-US',
          theme: 'light',
        },
        dryRun: options.dryRun ?? false,
        ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
        ...(options.maxPasses !== undefined ? { maxPasses: options.maxPasses } : {}),
      });
      const deterministicGenerator = new DeterministicHtmlGenerationProvider();
      const result = await new GenerationOrchestrator({
        structure: new LocalSvgStructureProvider(store, preparedDesign.structureLimits),
        generator: deterministicGenerator,
        preview: new LoopbackGeneratedPreviewProvider(),
        browser: new PlaywrightBrowserProvider(),
        artifacts: store,
        reporter: new HtmlGenerationReporter(store),
        exporter: new ReproducibleGenerationExporter(workspace),
        config,
      }).run(generationInput, controller.signal);
      const summary = generationSummary(result, runRoot);
      if (options.json) console.log(JSON.stringify(summary));
      else printGenerationSummary(summary);
      process.exitCode = generationExitCode(result.record);
    } finally {
      process.removeListener('SIGINT', cancel);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
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
  .option('--studio-agent', 'run the shared Studio plus MCP-agent setup checks')
  .option('--workspace <path>', 'dedicated Studio workspace', '.studio-workspace')
  .addOption(new Option('--host <host>').choices(['codex', 'claude', 'copilot']).default('codex'))
  .option('--json', 'emit JSON')
  .action(async (options: DoctorCliOptions) => {
    if (options.studioAgent) {
      const runtime = studioAgentRuntime();
      const mcpRoot = resolve(process.env['SMART_UI_MCP_ROOT'] ?? invocationRoot);
      const hostConfigPath = studioAgentHostConfigPath(options.host);
      const diagnosis = await runStudioAgentSetupChecks({
        workspaceRoot: userPath(options.workspace),
        mcpRoot,
        mcpEntryPath: runtime.mcpEntryPath,
        studioAssetsRoot: runtime.studioAssetsRoot,
        host: options.host,
        hostConfigPath,
        expectedHostConfig: studioAgentHostConfig(options.host, runtime.mcpEntryPath, mcpRoot),
        ...(runtime.sourcePaths ? { sourcePaths: runtime.sourcePaths } : {}),
        ...(runtime.studioSourcePaths ? { studioSourcePaths: runtime.studioSourcePaths } : {}),
      });
      print(diagnosis, options.json);
      if (!diagnosis.ready) process.exitCode = 4;
      return;
    }
    const diagnosis = await runDoctor(userPath(options.target));
    print(diagnosis, options.json);
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

function containedUserPath(workspace: string, path: string, label: string): string {
  const candidate = userPath(path);
  const relation = relative(workspace, candidate);
  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new SmartUiError('POLICY_VIOLATION', `${label} must stay inside the declared workspace.`);
  }
  return candidate;
}

async function readCliDesignContexts(
  workspace: string,
  options: GenerateCliOptions,
): Promise<{
  structuredDesignContext?: StructuredDesignContext;
  designContext?: ReturnType<typeof generationDesignContextSchema.parse>;
}> {
  let structuredDesignContext = options.structuredDesignContext;
  if (options.structuredContext) {
    structuredDesignContext = structuredDesignContextSchema.parse(
      JSON.parse(
        await readFile(
          containedUserPath(workspace, options.structuredContext, 'structured design context'),
          'utf8',
        ),
      ),
    );
  }
  if (!options.designContext) {
    return structuredDesignContext ? { structuredDesignContext } : {};
  }
  const path = await containedRegularCliFile(
    workspace,
    containedUserPath(workspace, options.designContext, 'design context'),
    'Design context',
  );
  const bytes = await readFile(path);
  if (bytes.byteLength < 1 || bytes.byteLength > 256_000) {
    throw new SmartUiError(
      'INVALID_INPUT',
      'Design context must be a non-empty UTF-8 file no larger than 256000 bytes.',
    );
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SmartUiError('INVALID_INPUT', 'Design context must be strict UTF-8 text.');
  }
  if (content.includes('\0')) {
    throw new SmartUiError('INVALID_INPUT', 'Design context must be text, not binary data.');
  }
  if (!options.structuredContext && !structuredDesignContext) {
    try {
      const legacy = structuredDesignContextSchema.safeParse(JSON.parse(content));
      if (legacy.success) return { structuredDesignContext: legacy.data };
    } catch {
      // Non-JSON source context is expected here.
    }
  }
  const redacted = redactSensitiveValue(content);
  if (typeof redacted !== 'string') {
    throw new SmartUiError('INVALID_INPUT', 'Design context could not be normalized as text.');
  }
  return {
    ...(structuredDesignContext ? { structuredDesignContext } : {}),
    designContext: generationDesignContextSchema.parse({
      filename: basename(path),
      mediaType: sourceContextMediaType(path),
      content: redacted,
      originalHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteLength: bytes.byteLength,
      provenance: 'cli:user-supplied',
      contentRedacted: redacted !== content,
    }),
  };
}

async function prepareCliGenerationDesign(
  workspace: string,
  designPath: string,
  limits: Awaited<ReturnType<typeof loadConfig>>['generation']['limits'],
): Promise<{
  svgPath: string;
  name: string;
  structureLimits: Awaited<ReturnType<typeof loadConfig>>['generation']['limits'];
  stagingPath?: string;
  authoringReference: {
    filename: string;
    mediaType: 'image/svg+xml' | 'image/png';
    originalHash: string;
    byteLength: number;
    provenance: string;
  };
  designReference?: {
    path: string;
    filename: string;
    mediaType: 'image/png';
    originalHash: string;
    byteLength: number;
    provenance: string;
  };
}> {
  const path = await containedRegularCliFile(workspace, designPath, 'Design reference');
  const extension = extname(path).toLowerCase();
  if (extension === '.svg') {
    const bytes = await readFile(path);
    if (bytes.byteLength < 1 || bytes.byteLength > limits.maxSvgBytes) {
      throw new SmartUiError(
        'INVALID_INPUT',
        `SVG reference must be from 1 to ${limits.maxSvgBytes} bytes.`,
      );
    }
    return {
      svgPath: path,
      name: basename(path, extension),
      structureLimits: limits,
      authoringReference: {
        filename: basename(path),
        mediaType: 'image/svg+xml',
        originalHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        byteLength: bytes.byteLength,
        provenance: 'cli:user-supplied',
      },
    };
  }
  if (extension !== '.png') {
    throw new SmartUiError('INVALID_INPUT', 'Generation design must be an SVG or PNG file.');
  }
  const bytes = await readFile(path);
  if (bytes.byteLength < 1 || bytes.byteLength > limits.maxSvgBytes) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `PNG reference must be from 1 to ${limits.maxSvgBytes} bytes.`,
    );
  }
  const dimensions = readImageDimensions(bytes, 'image/png');
  if (!dimensions) throw new SmartUiError('INVALID_INPUT', 'PNG dimensions are unavailable.');
  const normalizedSvg = pngCliReferenceSvg(bytes, dimensions.width, dimensions.height);
  if (Buffer.byteLength(normalizedSvg) > 50_000_000) {
    throw new SmartUiError('INVALID_INPUT', 'PNG reference is too large to normalize safely.');
  }
  const stagingPath = await mkdtemp(join(resolve(workspace), '.smart-ui-png-input-'));
  try {
    const svgPath = join(stagingPath, 'reference.svg');
    await writeFile(svgPath, normalizedSvg, { flag: 'wx', mode: 0o600 });
    return {
      svgPath,
      name: basename(path, extension),
      stagingPath,
      structureLimits: {
        ...limits,
        maxSvgBytes: Math.max(limits.maxSvgBytes, Buffer.byteLength(normalizedSvg)),
        maxDecodedCharacters: Math.max(
          limits.maxDecodedCharacters,
          Buffer.byteLength(normalizedSvg),
        ),
      },
      authoringReference: {
        filename: basename(path),
        mediaType: 'image/png',
        originalHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        byteLength: bytes.byteLength,
        provenance: 'cli:user-supplied',
      },
      designReference: {
        path,
        filename: basename(path),
        mediaType: 'image/png',
        originalHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        byteLength: bytes.byteLength,
        provenance: 'cli:user-supplied',
      },
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function containedRegularCliFile(
  workspace: string,
  path: string,
  label: string,
): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SmartUiError('INVALID_INPUT', `${label} must be a regular file.`);
  }
  const [root, canonical] = await Promise.all([realpath(workspace), realpath(path)]);
  const relation = relative(root, canonical);
  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new SmartUiError('POLICY_VIOLATION', `${label} crosses outside the declared workspace.`);
  }
  // Preserve the caller's lexical workspace spelling (for example /var versus /private/var on
  // macOS) after the real paths have proved containment. Downstream policy checks compare the
  // declared workspace and candidate using that same lexical spelling.
  return resolve(path);
}

function pngCliReferenceSvg(bytes: Uint8Array, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/png;base64,${Buffer.from(bytes).toString('base64')}"/></svg>`;
}

function sourceContextMediaType(path: string): string {
  return (
    {
      '.js': 'text/javascript',
      '.jsx': 'text/javascript',
      '.ts': 'text/typescript',
      '.tsx': 'text/typescript',
      '.html': 'text/html',
      '.css': 'text/css',
      '.json': 'application/json',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
    }[extname(path).toLowerCase()] ?? 'text/plain'
  );
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

function parseStudioPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new SmartUiError('INVALID_INPUT', '--port must be an integer from 0 to 65535.');
  }
  return port;
}

function parseStudioRetentionHours(value: string): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 1 / 3600 || hours > 24 * 30) {
    throw new SmartUiError(
      'INVALID_INPUT',
      '--retention-hours must be from one second to 30 days.',
    );
  }
  return hours;
}

function studioAgentRuntime(): {
  mcpEntryPath: string;
  studioAssetsRoot: string;
  sourcePaths?: string[];
  studioSourcePaths?: string[];
} {
  const modulePath = fileURLToPath(import.meta.url);
  const repositoryRoot = resolve(dirname(modulePath), '..', '..', '..');
  if (
    modulePath.includes(`${join('apps', 'cli')}${process.platform === 'win32' ? '\\' : '/'}`) &&
    existsSync(join(repositoryRoot, 'apps', 'mcp-server', 'src', 'server.ts'))
  ) {
    return {
      mcpEntryPath: join(repositoryRoot, 'apps', 'mcp-server', 'dist', 'index.js'),
      studioAssetsRoot: join(repositoryRoot, 'apps', 'studio', 'dist', 'public'),
      sourcePaths: [
        join(repositoryRoot, 'apps', 'mcp-server', 'src'),
        join(repositoryRoot, 'packages', 'core', 'src'),
        join(repositoryRoot, 'package.json'),
        join(repositoryRoot, 'pnpm-lock.yaml'),
      ],
      studioSourcePaths: [
        join(repositoryRoot, 'apps', 'studio', 'src'),
        join(repositoryRoot, 'packages', 'core', 'src'),
        join(repositoryRoot, 'package.json'),
        join(repositoryRoot, 'pnpm-lock.yaml'),
      ],
    };
  }
  const serverModule = fileURLToPath(import.meta.resolve('smart-ui-validator-mcp'));
  return {
    mcpEntryPath: join(dirname(serverModule), 'index.js'),
    studioAssetsRoot: join(dirname(modulePath), 'studio', 'public'),
  };
}

function studioAgentHostConfigPath(host: StudioAgentHost): string {
  if (host === 'codex') return resolve(invocationRoot, '.codex', 'config.toml');
  if (host === 'claude') return resolve(invocationRoot, '.mcp.json');
  return resolve(invocationRoot, '.vscode', 'mcp.json');
}

function studioAgentHostConfig(
  host: StudioAgentHost,
  mcpEntryPath: string,
  mcpRoot: string,
): string {
  if (host === 'codex') {
    return `[mcp_servers.smart_ui]\ncommand = "node"\nargs = [${JSON.stringify(mcpEntryPath)}]\ncwd = ${JSON.stringify(mcpRoot)}\nenv = { SMART_UI_MCP_ROOT = ${JSON.stringify(mcpRoot)} }\nstartup_timeout_sec = 20\ntool_timeout_sec = 120\nrequired = true\nenabled = true\ndefault_tools_approval_mode = "writes"\n`;
  }
  const server = {
    type: 'stdio',
    command: 'node',
    args: [mcpEntryPath],
    env: { SMART_UI_MCP_ROOT: mcpRoot },
  };
  return `${JSON.stringify(
    host === 'claude'
      ? { mcpServers: { 'smart-ui': server } }
      : { servers: { 'smart-ui': { ...server, sandboxEnabled: true } } },
    null,
    2,
  )}\n`;
}

function studioAgentRestartAction(host: StudioAgentHost): string {
  if (host === 'codex')
    return 'Restart the Codex app or CLI session so it reloads .codex/config.toml.';
  if (host === 'claude') return 'Restart Claude Code so it reloads .mcp.json.';
  return 'Run “MCP: Reset Cached Tools” in VS Code, then restart the Copilot agent session.';
}

async function runExplicitProcess(executable: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? accept()
        : reject(new Error(`${executable} ${args.join(' ')} exited with code ${code ?? -1}.`)),
    );
  });
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? { executable: 'open', args: [url] }
      : process.platform === 'win32'
        ? { executable: 'cmd', args: ['/c', 'start', '', url] }
        : { executable: 'xdg-open', args: [url] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function waitForStudioShutdown(server: { close(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolveShutdown, rejectShutdown) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void server.close().then(resolveShutdown, rejectShutdown);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
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
    engine: result.record.provenance.hostProposal ? 'agent' : 'deterministic',
    authoringHost: result.record.provenance.host,
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
    designReference:
      result.record.schemaVersion === '2.0' && result.record.designReference
        ? {
            mediaType: result.record.designReference.mediaType,
            hash: result.record.input.designReferenceOriginalHash,
            byteLength: result.record.designReference.byteLength,
            artifact: resolve(artifactRoot, result.record.designReference.relativePath),
          }
        : undefined,
    designContext:
      result.record.schemaVersion === '2.0' && result.record.designContext
        ? {
            hash: result.record.input.designContextOriginalHash,
            contentRedacted: result.record.input.designContextContentRedacted,
            byteLength: result.record.designContext.byteLength,
            artifact: resolve(artifactRoot, result.record.designContext.relativePath),
          }
        : undefined,
    exportedFiles: result.exportedFiles,
    warnings: result.record.warnings,
    failures: result.record.failures,
  };
}

function printGenerationSummary(summary: ReturnType<typeof generationSummary>): void {
  console.log(`Generation ${summary.generationId}: ${summary.status} (${summary.stoppedReason})`);
  console.log(
    `Engine: ${summary.engine}${summary.authoringHost ? ` (${summary.authoringHost})` : ''}`,
  );
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
  if (summary.designReference) {
    console.log(
      `Design reference: ${summary.designReference.mediaType} (${summary.designReference.hash})`,
    );
  }
  if (summary.designContext) {
    console.log(
      `Design context: ${summary.designContext.hash}${summary.designContext.contentRedacted ? ' (redacted)' : ''}`,
    );
  }
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
  engine: 'deterministic' | 'agent';
  mode: 'exact' | 'hybrid' | 'semantic';
  layout: 'fixed' | 'responsive' | 'component';
  name?: string;
  instructions?: string;
  designContext?: string;
  structuredContext?: string;
  presentation?: string;
  structuredDesignContext?: StructuredDesignContext;
  presentationSpec?: PresentationSpec;
  viewport?: { width: number; height: number; deviceScaleFactor: number };
  timeout?: number;
  maxPasses?: number;
  dryRun?: boolean;
  json?: boolean;
}

interface StudioCliOptions {
  workspace?: string;
  init?: boolean;
  initOnly?: boolean;
  open?: boolean;
  target?: string;
  reviewTask?: string;
  port: number;
  retentionHours: number;
  healthCheck?: boolean;
  agent?: boolean;
  host: StudioAgentHost;
  checkOnly?: boolean;
  dryRun?: boolean;
  ensureEngine?: boolean;
  json?: boolean;
}

interface DoctorCliOptions {
  target: string;
  studioAgent?: boolean;
  workspace: string;
  host: StudioAgentHost;
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
