#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  HtmlReporter,
  LocalArtifactStore,
  LocalImageDesignProvider,
  LocalPolicy,
  MockCodingProvider,
  PlaywrightBrowserProvider,
  ReactFrameworkAdapter,
  SmartUiError,
  SmartUiOrchestrator,
  designContractSchema,
  runRecordSchema,
} from '@smart-ui/core';

const program = new Command()
  .name('smart-ui')
  .description('Inspect, normalize, render, and report UI implementation evidence')
  .version('0.1.0')
  .showSuggestionAfterError();

const invocationRoot = process.env['INIT_CWD'] ?? process.cwd();

program
  .command('inspect')
  .requiredOption('--target <path>', 'React repository root')
  .option('--json', 'emit JSON')
  .action(async ({ target, json }: { target: string; json?: boolean }) => {
    const result = await new ReactFrameworkAdapter().inspect(userPath(target));
    print(result, json);
  });

const design = program.command('design').description('Design evidence operations');
design
  .command('normalize')
  .requiredOption('--image <path>', 'local PNG, JPEG, or WebP reference')
  .option('--spec <path>', 'optional JSON sidecar')
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
      spec,
    });
    await writeFile(userPath(options.out), `${JSON.stringify(contract, null, 2)}\n`);
    print(contract, options.json);
  });

program
  .command('run')
  .requiredOption('--target <path>', 'React repository root')
  .requiredOption('--design <path>', 'DesignContract JSON file')
  .requiredOption('--route <url>', 'fully qualified fixture URL')
  .option('--artifacts <path>', 'artifact directory (defaults under target)')
  .option('--allow-write <path...>', 'target-relative files a coding provider may write', [])
  .option('--dry-run', 'record proposed work without source writes')
  .option('--json', 'emit JSON')
  .action(async (options: RunCliOptions) => {
    const target = userPath(options.target);
    const artifactRoot = options.artifacts
      ? userPath(options.artifacts)
      : join(target, '.smart-ui', 'artifacts');
    const store = new LocalArtifactStore(artifactRoot);
    const contract = designContractSchema.parse(
      JSON.parse(await readFile(userPath(options.design), 'utf8')),
    );
    const policy = new LocalPolicy({
      targetRoot: target,
      writableFiles: options.allowWrite,
      dryRun: options.dryRun ?? false,
      maxExecutionTimeMs: 60_000,
    });
    const orchestrator = new SmartUiOrchestrator({
      framework: new ReactFrameworkAdapter(),
      coding: new MockCodingProvider(),
      browser: new PlaywrightBrowserProvider(),
      artifacts: store,
      policy,
      reporter: new HtmlReporter(store),
    });
    const result = await orchestrator.run({
      targetRoot: target,
      designContractPath: userPath(options.design),
      contract,
      url: options.route,
    });
    print(result, options.json);
    if (result.record.status === 'failed') process.exitCode = 4;
  });

program
  .command('report')
  .argument('<run-record>', 'RunRecord JSON path')
  .addOption(new Option('--format <format>').choices(['html', 'json']).default('html'))
  .option('--artifacts <path>', 'artifact directory', '.smart-ui/artifacts')
  .option('--json', 'emit JSON')
  .action(async (recordPath: string, options: ReportOptions) => {
    const record = runRecordSchema.parse(JSON.parse(await readFile(userPath(recordPath), 'utf8')));
    if (options.format === 'json') return print(record, true);
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

function print(value: unknown, json?: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function userPath(path: string): string {
  return resolve(invocationRoot, path);
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
  dryRun?: boolean;
  json?: boolean;
}
interface ReportOptions {
  format: 'html' | 'json';
  artifacts: string;
  json?: boolean;
}
