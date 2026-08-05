import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
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
import type { RepairProvider } from './repair-provider.js';
import { runRecordSchema, type DesignContract, type RunRecord, type PassRecord, type ValidationFinding, type ArtifactRef } from './schemas.js';
import { loadConfig } from './config.js';
import { SmartUiComparator } from './comparator.js';
import { runAllowedProcess } from './process.js';

export interface RunOptions {
  targetRoot: string;
  designContractPath: string;
  contract: DesignContract;
  url: string;
}

export interface OrchestratorDependencies {
  framework: FrameworkAdapter;
  coding: CodingProvider;
  repair: RepairProvider;
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
    const artifacts: ArtifactRef[] = [];
    const failures: RunRecord['failures'] = [];
    const decisions: RunRecord['decisions'] = [];
    let status: RunRecord['status'] = this.dependencies.policy.dryRun ? 'dry-run' : 'succeeded';

    const config = await loadConfig(options.targetRoot);
    const comparator = new SmartUiComparator(config);

    const passes: PassRecord[] = [];
    let finalScore: number | undefined;

    try {
      const inspectStart = performance.now();
      const inspection = await this.dependencies.framework.inspect(options.targetRoot);
      timings.inspect = performance.now() - inspectStart;
      decisions.push({
        kind: 'framework',
        message: `Detected ${inspection.framework} with ${inspection.buildSystem ?? 'unknown build system'}`,
      });

      let referencePng: Uint8Array | null = null;
      try {
        referencePng = await this.dependencies.artifacts.read(options.contract.reference.relativePath);
      } catch {
        // Fallback or record warning if reference image cannot be retrieved
      }

      const maxPasses = config.validation.maxRepairPasses;
      let lastFindings: ValidationFinding[] = [];
      let lastScore = 0;

      for (let passIndex = 0; passIndex < maxPasses; passIndex++) {
        const passStart = performance.now();
        const passFailures: PassRecord['failures'] = [];
        const passTimings: Record<string, number> = {};

        const captureStart = performance.now();
        const browserEvidence = await this.dependencies.browser.capture({
          url: options.url,
          viewport: options.contract.viewport,
          timeoutMs: this.dependencies.policy.maxExecutionTimeMs,
        });
        passTimings.capture = performance.now() - captureStart;

        const compareStart = performance.now();
        const comparison = await comparator.compare(options.contract, browserEvidence, referencePng);
        passTimings.compare = performance.now() - compareStart;

        const currentFindings = comparison.findings;
        const currentScore = comparison.score;
        finalScore = currentScore;

        let passScreenshotRef;
        if (browserEvidence.screenshot.length > 0) {
          passScreenshotRef = await this.dependencies.artifacts.put(
            browserEvidence.screenshot,
            'image/png',
            `pass-${passIndex}-screenshot.png`,
          );
          artifacts.push(passScreenshotRef);
        }

        let passHeatmapRef;
        if (comparison.heatmap && comparison.heatmap.length > 0) {
          passHeatmapRef = await this.dependencies.artifacts.put(
            comparison.heatmap,
            'image/png',
            `pass-${passIndex}-heatmap.png`,
          );
          artifacts.push(passHeatmapRef);
        }

        const passRecord: PassRecord = {
          passIndex,
          findings: currentFindings,
          score: currentScore,
          changedFiles: [],
          reverted: false,
          screenshot: passScreenshotRef,
          heatmap: passHeatmapRef,
          timingsMs: passTimings,
          failures: passFailures,
        };
        passes.push(passRecord);

        if (currentScore === 100 && currentFindings.length === 0) {
          decisions.push({
            kind: 'repair',
            message: `Pass ${passIndex}: Success! Perfect similarity achieved.`,
          });
          break;
        }

        if (passIndex > 0 && currentScore <= lastScore && areFindingsEqual(currentFindings, lastFindings)) {
          decisions.push({
            kind: 'repair',
            message: `Pass ${passIndex}: Stopped. Mismatches are identical to previous pass with no score improvement.`,
          });
          break;
        }

        lastFindings = currentFindings;
        lastScore = currentScore;

        // Construct mock RunRecord representing current state to pass to repair provider
        const currentRunRecord = runRecordSchema.parse({
          schemaVersion: '1.0',
          id,
          status,
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          targetRoot: resolve(options.targetRoot),
          designContract: options.designContractPath,
          inputs: { url: options.url, designId: options.contract.id },
          decisions,
          artifacts: [],
          changedFiles,
          timingsMs: timings,
          warnings: options.contract.ambiguities,
          failures,
          provenance: { tool: 'smart-ui', version: '0.1.0' },
          passes,
          score: currentScore,
        });

        const repairStart = performance.now();
        const proposedChanges = await this.dependencies.repair.proposeRepair({
          contract: options.contract,
          inspection,
          findings: currentFindings,
          runRecord: currentRunRecord,
          passIndex,
        });
        passTimings.repair = performance.now() - repairStart;

        if (proposedChanges.length === 0) {
          decisions.push({
            kind: 'repair',
            message: `Pass ${passIndex}: Stopped. Repair provider proposed no changes.`,
          });
          break;
        }

        const passChangedFiles: string[] = [];
        const originalFileContents = new Map<string, string>();
        let regressionDetected = false;

        if (!this.dependencies.policy.dryRun) {
          for (const change of proposedChanges) {
            this.dependencies.policy.assertWritable(change.relativePath);
            const filePath = resolve(options.targetRoot, change.relativePath);

            try {
              const original = await readFile(filePath, 'utf8');
              originalFileContents.set(filePath, original);
            } catch {
              // File is new
            }

            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, change.content, 'utf8');
            passChangedFiles.push(change.relativePath);
            if (!changedFiles.includes(change.relativePath)) {
              changedFiles.push(change.relativePath);
            }
          }

          passRecord.changedFiles = passChangedFiles;

          if (config.commands.format) {
            const formatSuccess = await this.runTargetCommand(config.commands.format, options.targetRoot);
            if (!formatSuccess) {
              passFailures.push({ code: 'FORMAT_FAILURE', message: 'Formatting command failed.', recoverable: true });
            }
          }

          if (config.commands.typecheck) {
            const typecheckSuccess = await this.runTargetCommand(config.commands.typecheck, options.targetRoot);
            if (!typecheckSuccess) {
              regressionDetected = true;
              passFailures.push({ code: 'TYPECHECK_REGRESSION', message: 'Typechecking failed after patch.', recoverable: true });
            }
          }

          if (config.commands.test) {
            const testSuccess = await this.runTargetCommand(config.commands.test, options.targetRoot);
            if (!testSuccess) {
              regressionDetected = true;
              passFailures.push({ code: 'TEST_REGRESSION', message: 'Tests failed after patch.', recoverable: true });
            }
          }

          if (regressionDetected) {
            passRecord.reverted = true;
            decisions.push({
              kind: 'repair',
              message: `Pass ${passIndex}: Regression detected. Reverting changes for this pass.`,
            });
            for (const [filePath, content] of originalFileContents.entries()) {
              await writeFile(filePath, content, 'utf8');
            }
          } else {
            decisions.push({
              kind: 'repair',
              message: `Pass ${passIndex}: Successfully applied patch. Files: ${passChangedFiles.join(', ')}`,
            });
          }
        } else {
          decisions.push({
            kind: 'dry-run',
            message: `Pass ${passIndex} (dry-run): Proposes writing changes to ${proposedChanges.map((c) => c.relativePath).join(', ')}`,
          });
        }

        if (regressionDetected) {
          break;
        }
      }
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
      passes,
      score: finalScore,
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

  private async runTargetCommand(fullCommand: string, targetRoot: string): Promise<boolean> {
    try {
      const parts = fullCommand.trim().split(/\s+/);
      const command = parts[0] || '';
      if (!command) return false;
      const args = parts.slice(1);
      const result = await runAllowedProcess(this.dependencies.policy, command, args, targetRoot);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}

function areFindingsEqual(f1: ValidationFinding[], f2: ValidationFinding[]): boolean {
  if (f1.length !== f2.length) return false;
  return f1.every((finding, idx) => {
    const other = f2[idx];
    if (!other) return false;
    return (
      finding.category === other.category &&
      finding.message === other.message &&
      finding.targetDomLocator === other.targetDomLocator
    );
  });
}
