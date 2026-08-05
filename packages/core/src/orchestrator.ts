import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SmartUiError } from './errors.js';
import type {
  ArtifactStore,
  BrowserProvider,
  CodingProvider,
  FrameworkAdapter,
  PolicyProvider,
  Reporter,
} from './providers.js';
import { runRecordSchema, type DesignContract, type RunRecord } from './schemas.js';

export interface RunOptions {
  targetRoot: string;
  designContractPath: string;
  contract: DesignContract;
  url: string;
}

export interface OrchestratorDependencies {
  framework: FrameworkAdapter;
  coding: CodingProvider;
  browser: BrowserProvider;
  artifacts: ArtifactStore;
  policy: PolicyProvider;
  reporter: Reporter;
}

export class SmartUiOrchestrator {
  constructor(private readonly dependencies: OrchestratorDependencies) {}

  async run(options: RunOptions): Promise<{ record: RunRecord; report: string | null }> {
    const id = randomUUID();
    const startedAt = new Date();
    const timings: Record<string, number> = {};
    const changedFiles: string[] = [];
    const artifacts = [];
    const failures: RunRecord['failures'] = [];
    const decisions: RunRecord['decisions'] = [];
    let status: RunRecord['status'] = this.dependencies.policy.dryRun ? 'dry-run' : 'succeeded';

    try {
      const inspectStart = performance.now();
      const inspection = await this.dependencies.framework.inspect(options.targetRoot);
      timings.inspect = performance.now() - inspectStart;
      decisions.push({
        kind: 'framework',
        message: `Detected ${inspection.framework} with ${inspection.buildSystem ?? 'unknown build system'}`,
      });

      const changes = await this.dependencies.coding.propose(options.contract, inspection);
      for (const change of changes) {
        this.dependencies.policy.assertWritable(change.relativePath);
        decisions.push({ kind: 'change', message: `${change.relativePath}: ${change.rationale}` });
        if (!this.dependencies.policy.dryRun) {
          const destination = resolve(options.targetRoot, change.relativePath);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, change.content);
          changedFiles.push(change.relativePath);
        }
      }

      const captureStart = performance.now();
      const screenshot = await this.dependencies.browser.capture({
        url: options.url,
        viewport: options.contract.viewport,
        timeoutMs: this.dependencies.policy.maxExecutionTimeMs,
      });
      timings.capture = performance.now() - captureStart;
      artifacts.push(
        await this.dependencies.artifacts.put(screenshot, 'image/png', 'implementation.png'),
      );
    } catch (error) {
      status = 'failed';
      failures.push({
        code: error instanceof SmartUiError ? error.code : 'UNEXPECTED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
    }

    const completedAt = new Date();
    timings.total = completedAt.getTime() - startedAt.getTime();
    let record = runRecordSchema.parse({
      schemaVersion: '1.0',
      id,
      status,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      targetRoot: resolve(options.targetRoot),
      designContract: options.designContractPath,
      inputs: { url: options.url, designId: options.contract.id },
      decisions,
      artifacts,
      changedFiles,
      timingsMs: timings,
      warnings: options.contract.ambiguities,
      failures,
      provenance: { tool: 'smart-ui', version: '0.1.0' },
    });
    const recordArtifact = await this.dependencies.artifacts.put(
      new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
      'application/json',
      `${id}.run.json`,
    );
    record = { ...record, artifacts: [...record.artifacts, recordArtifact] };
    const report = await this.dependencies.reporter.write(record);
    return { record, report: report.relativePath };
  }
}
