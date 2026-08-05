import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { CommandSpec, Config } from './config.js';
import { loadConfig } from './config.js';
import { SmartUiComparator, type ComparisonResult, type ReferenceImage } from './comparator.js';
import { SmartUiError } from './errors.js';
import { runAllowedProcess } from './process.js';
import { redactSensitiveText } from './security.js';
import type {
  ArtifactStore,
  BrowserProvider,
  CodingProvider,
  FrameworkAdapter,
  PolicyProvider,
  ProposedChange,
  Reporter,
} from './providers.js';
import type { MemoryContext, MemoryProvider, RecallBudget } from './memory.js';
import type { RepairProposalInput, RepairProvider } from './repair-provider.js';
import {
  passRecordSchema,
  runRecordSchema,
  type ArtifactRef,
  type DesignContract,
  type PassRecord,
  type RunRecord,
  type StopReason,
  type ValidationFinding,
} from './schemas.js';

export interface RunOptions {
  targetRoot: string;
  designContractPath: string;
  contract: DesignContract;
  url: string;
  repairEnabled?: boolean;
  maxRepairPasses?: number;
  signal?: AbortSignal;
  memoryContext?: MemoryContext;
  memoryBudget?: RecallBudget;
}

export interface OrchestratorDependencies {
  framework: FrameworkAdapter;
  /** Kept for Phase 1 API compatibility; repair uses the provider-neutral RepairProvider. */
  coding: CodingProvider;
  repair: RepairProvider;
  browser: BrowserProvider;
  artifacts: ArtifactStore;
  policy: PolicyProvider;
  reporter: Reporter;
  memory?: MemoryProvider;
}

interface FileSnapshot {
  relativePath: string;
  absolutePath: string;
  existed: boolean;
  content?: Uint8Array;
}

interface PatchTransaction {
  hash: string;
  files: string[];
  rationale: string[];
  snapshots: FileSnapshot[];
  previousScore: number;
  previousFindingSignature: string;
}

interface CapturedPass {
  comparison: ComparisonResult;
  screenshot?: ArtifactRef;
  diff?: ArtifactRef;
  overlay?: ArtifactRef;
  timings: Record<string, number>;
}

export class SmartUiOrchestrator {
  constructor(private readonly dependencies: OrchestratorDependencies) {}

  async run(options: RunOptions): Promise<{ record: RunRecord; report: string | null }> {
    const id = randomUUID();
    const startedAt = new Date();
    const timings: Record<string, number> = {};
    const artifacts: ArtifactRef[] = [options.contract.reference];
    const failures: RunRecord['failures'] = [];
    const decisions: RunRecord['decisions'] = [];
    const passes: PassRecord[] = [];
    const committedChangedFiles = new Set<string>();
    let finalScore: number | undefined;
    let stoppedReason: StopReason = 'provider-failure';
    let status: RunRecord['status'] = 'succeeded';
    let pendingTransaction: PatchTransaction | null = null;

    const config = await loadConfig(options.targetRoot);
    const repairEnabled = options.repairEnabled ?? true;
    const maxRepairPasses = Math.min(
      options.maxRepairPasses ?? config.validation.maxRepairPasses,
      config.validation.maxRepairPasses,
    );

    try {
      this.dependencies.policy.assertEndpoint(options.url);
      const inspectStart = performance.now();
      const inspection = await this.dependencies.framework.inspect(options.targetRoot);
      timings.inspect = performance.now() - inspectStart;
      decisions.push({
        kind: 'framework',
        message: `Detected ${inspection.framework} with ${inspection.buildSystem ?? 'unknown build system'}`,
      });

      if (this.dependencies.memory && options.memoryContext) {
        const recallStart = performance.now();
        const recall = await this.dependencies.memory.recall(
          options.memoryContext,
          options.memoryBudget ?? {
            maxRecords: config.memory.maxRecords,
            maxCharactersPerMemory: config.memory.maxCharactersPerMemory,
            maxTotalCharacters: config.memory.maxTotalCharacters,
          },
        );
        timings.memoryRecall = performance.now() - recallStart;
        decisions.push({
          kind: 'memory-recall',
          message: JSON.stringify({
            advisoryOnly: true,
            memoryIds: recall.records.map((record) => record.id),
            characters: recall.characters,
            estimatedTokens: recall.estimatedTokens,
            excluded: recall.excluded,
          }),
        });
      }

      const reference = await this.readReference(options.contract, config);
      const comparator = new SmartUiComparator(config);
      const patchHashes = new Set<string>();
      const findingSignatures = new Set<string>();
      const scores: number[] = [];
      let repairAttempts = 0;

      while (true) {
        if (options.signal?.aborted) {
          if (pendingTransaction) await rollback(pendingTransaction);
          stoppedReason = 'canceled';
          decisions.push({
            kind: 'repair',
            message: 'Run canceled before the next validation pass.',
          });
          break;
        }

        let captured = await this.captureAndCompare(
          options,
          config,
          comparator,
          reference,
          artifacts,
        );
        finalScore = captured.comparison.score;

        if (pendingTransaction) {
          const improvement = captured.comparison.score - pendingTransaction.previousScore;
          const attemptedFindingSignature = signatureForFindings(captured.comparison.findings);
          if (attemptedFindingSignature === pendingTransaction.previousFindingSignature) {
            passes.push(
              makePassRecord(passes.length, captured, pendingTransaction, true, [
                {
                  code: 'REPEATED_FINDINGS',
                  message: 'The same deterministic findings remained after the patch.',
                  recoverable: true,
                },
              ]),
            );
            await rollback(pendingTransaction);
            pendingTransaction = null;
            captured = await this.captureAndCompare(
              options,
              config,
              comparator,
              reference,
              artifacts,
            );
            finalScore = captured.comparison.score;
            passes.push(makePassRecord(passes.length, captured, null, false, []));
            stoppedReason = 'repeated-findings';
            decisions.push({
              kind: 'repair',
              message: 'Repeated findings caused the current patch to be reverted.',
            });
            break;
          }
          if (improvement < config.validation.minimumScoreImprovement) {
            passes.push(
              makePassRecord(passes.length, captured, pendingTransaction, true, [
                {
                  code: 'NO_IMPROVEMENT',
                  message: `Patch changed score by ${improvement.toFixed(3)}, below the required ${config.validation.minimumScoreImprovement}.`,
                  recoverable: true,
                },
              ]),
            );
            decisions.push({
              kind: 'repair',
              message: `Repair ${pendingTransaction.hash} produced no measurable improvement and was reverted.`,
            });
            await rollback(pendingTransaction);
            pendingTransaction = null;
            captured = await this.captureAndCompare(
              options,
              config,
              comparator,
              reference,
              artifacts,
            );
            finalScore = captured.comparison.score;
            passes.push(makePassRecord(passes.length, captured, null, false, []));
            stoppedReason = 'no-improvement';
            break;
          }
          for (const file of pendingTransaction.files) committedChangedFiles.add(file);
          decisions.push({
            kind: 'repair',
            message: `Repair ${pendingTransaction.hash} improved the score by ${improvement.toFixed(3)}.`,
          });
          pendingTransaction = null;
        }

        scores.push(captured.comparison.score);
        const findingSignature = signatureForFindings(captured.comparison.findings);
        const repeatedFindings = findingSignatures.has(findingSignature);
        findingSignatures.add(findingSignature);

        if (captured.comparison.findings.length === 0 && captured.comparison.score === 100) {
          passes.push(makePassRecord(passes.length, captured, null, false, []));
          stoppedReason = 'success';
          decisions.push({
            kind: 'repair',
            message: 'Validation completed with no remaining findings.',
          });
          break;
        }

        if (!repairEnabled) {
          passes.push(makePassRecord(passes.length, captured, null, false, []));
          stoppedReason = 'validation-only';
          break;
        }

        if (repeatedFindings && repairAttempts > 0) {
          passes.push(makePassRecord(passes.length, captured, null, false, []));
          stoppedReason = 'repeated-findings';
          decisions.push({
            kind: 'repair',
            message: 'Stopped because the same deterministic findings repeated.',
          });
          break;
        }

        if (repairAttempts >= maxRepairPasses) {
          passes.push(makePassRecord(passes.length, captured, null, false, []));
          stoppedReason = 'maximum-passes';
          decisions.push({
            kind: 'repair',
            message: `Stopped at the configured limit of ${maxRepairPasses} repair passes.`,
          });
          break;
        }

        const proposalInput = compactRepairInput(
          id,
          options.contract,
          inspection,
          captured.comparison.findings,
          artifacts,
          scores,
          repairAttempts,
          config.evidence.maxDiagnosticCharacters,
        );
        const repairStart = performance.now();
        const proposedChanges = await this.dependencies.repair.proposeRepair(proposalInput);
        captured.timings.repair = performance.now() - repairStart;
        validateProposal(proposedChanges);

        if (proposedChanges.length === 0) {
          passes.push(makePassRecord(passes.length, captured, null, false, []));
          stoppedReason = 'no-changes';
          decisions.push({ kind: 'repair', message: 'Repair provider proposed no changes.' });
          break;
        }

        const patchHash = hashProposal(proposedChanges);
        const transactionBase = {
          hash: patchHash,
          files: proposedChanges.map((change) => change.relativePath),
          rationale: proposedChanges.map((change) => change.rationale),
        };
        if (patchHashes.has(patchHash)) {
          passes.push(
            makePassRecord(
              passes.length,
              captured,
              {
                ...transactionBase,
                snapshots: [],
                previousScore: captured.comparison.score,
                previousFindingSignature: findingSignature,
              },
              false,
              [],
            ),
          );
          stoppedReason = 'repeated-patch';
          decisions.push({
            kind: 'repair',
            message: `Stopped because repair ${patchHash} was already proposed.`,
          });
          break;
        }
        patchHashes.add(patchHash);

        if (this.dependencies.policy.dryRun) {
          passes.push(
            makePassRecord(
              passes.length,
              captured,
              {
                ...transactionBase,
                snapshots: [],
                previousScore: captured.comparison.score,
                previousFindingSignature: findingSignature,
              },
              false,
              [],
            ),
          );
          stoppedReason = 'dry-run';
          status = 'dry-run';
          decisions.push({
            kind: 'dry-run',
            message: `Would apply ${patchHash} to ${transactionBase.files.join(', ')}.`,
          });
          break;
        }

        const snapshots = await this.applyProposal(options.targetRoot, proposedChanges);
        repairAttempts++;
        const transaction: PatchTransaction = {
          ...transactionBase,
          snapshots,
          previousScore: captured.comparison.score,
          previousFindingSignature: findingSignature,
        };
        const commandFailures = await this.runPostPatchCommands(
          config.commands,
          options.targetRoot,
        );
        if (commandFailures.length > 0) {
          await rollback(transaction);
          passes.push(makePassRecord(passes.length, captured, transaction, true, commandFailures));
          stoppedReason = 'test-regression';
          decisions.push({
            kind: 'repair',
            message: `Repair ${patchHash} failed repository checks and was reverted.`,
          });
          break;
        }

        passes.push(makePassRecord(passes.length, captured, transaction, false, []));
        pendingTransaction = transaction;
      }
    } catch (error) {
      if (pendingTransaction) {
        await rollback(pendingTransaction).catch(() => undefined);
        pendingTransaction = null;
      }
      status = 'failed';
      stoppedReason = stopReasonFor(error);
      failures.push({
        code: error instanceof SmartUiError ? error.code : 'UNEXPECTED',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
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
      targetArtifact: options.contract.reference,
      artifacts: uniqueArtifacts(artifacts),
      changedFiles: [...committedChangedFiles].sort(),
      timingsMs: timings,
      warnings: [...options.contract.ambiguities, ...options.contract.sourceEvidence.uncertainties],
      failures,
      provenance: { tool: 'smart-ui', version: '0.3.0' },
      passes,
      ...(finalScore === undefined ? {} : { score: finalScore }),
      stoppedReason,
    });

    let reportPath: string | null = null;
    try {
      const report = await this.dependencies.reporter.write(record);
      artifacts.push(report);
      reportPath = report.relativePath;
      record = runRecordSchema.parse({ ...record, artifacts: uniqueArtifacts(artifacts) });
    } catch (error) {
      failures.push({
        code: 'REPORT_FAILURE',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        recoverable: true,
      });
      status = 'failed';
      record = runRecordSchema.parse({ ...record, status, failures });
    }

    const recordArtifact = await this.dependencies.artifacts.put(
      new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
      'application/json',
      `${id}.run.json`,
    );
    record = runRecordSchema.parse({
      ...record,
      artifacts: uniqueArtifacts([...record.artifacts, recordArtifact]),
    });
    await this.dependencies.memory?.close?.();
    return { record: deepFreeze(record), report: reportPath };
  }

  private async readReference(contract: DesignContract, config: Config): Promise<ReferenceImage> {
    const bytes = await this.dependencies.artifacts.read(contract.reference.relativePath);
    if (bytes.byteLength > config.evidence.maxArtifactBytes) {
      throw new SmartUiError(
        'INVALID_INPUT',
        `Reference artifact exceeds ${config.evidence.maxArtifactBytes} bytes.`,
      );
    }
    return { bytes, mediaType: contract.reference.mediaType };
  }

  private async captureAndCompare(
    options: RunOptions,
    config: Config,
    comparator: SmartUiComparator,
    reference: ReferenceImage,
    artifacts: ArtifactRef[],
  ): Promise<CapturedPass> {
    const timings: Record<string, number> = {};
    const captureStart = performance.now();
    const evidence = await this.dependencies.browser.capture({
      url: options.url,
      viewport: options.contract.viewport,
      timeoutMs: this.dependencies.policy.maxExecutionTimeMs,
      locale: options.contract.locale,
      theme: options.contract.theme,
      allowedEndpoints: config.policy.endpointAllowlist,
      blockExternalNetwork: config.policy.blockExternalNetwork,
      evidenceLimits: config.evidence,
    });
    timings.capture = performance.now() - captureStart;
    const compareStart = performance.now();
    const comparison = await comparator.compare(options.contract, evidence, reference);
    timings.compare = performance.now() - compareStart;

    const screenshot = await this.putOptional(evidence.screenshot, 'implementation.png');
    const diff = await this.putOptional(comparison.diff, 'diff.png');
    const overlay = await this.putOptional(comparison.overlay, 'overlay.png');
    for (const artifact of [screenshot, diff, overlay]) if (artifact) artifacts.push(artifact);
    const evidenceArtifacts = uniqueArtifacts([
      options.contract.reference,
      ...(screenshot ? [screenshot] : []),
      ...(diff ? [diff] : []),
      ...(overlay ? [overlay] : []),
    ]);
    comparison.findings = comparison.findings.map((item) => ({ ...item, evidenceArtifacts }));
    return {
      comparison,
      ...(screenshot ? { screenshot } : {}),
      ...(diff ? { diff } : {}),
      ...(overlay ? { overlay } : {}),
      timings,
    };
  }

  private async putOptional(
    bytes: Uint8Array | null,
    label: string,
  ): Promise<ArtifactRef | undefined> {
    if (!bytes || bytes.length === 0) return undefined;
    return this.dependencies.artifacts.put(bytes, 'image/png', label);
  }

  private async applyProposal(
    targetRoot: string,
    changes: ProposedChange[],
  ): Promise<FileSnapshot[]> {
    const snapshots: FileSnapshot[] = [];
    for (const change of changes) {
      this.dependencies.policy.assertWritable(change.relativePath);
      await assertNoSymlinkPath(targetRoot, change.relativePath);
      const absolutePath = resolve(targetRoot, change.relativePath);
      try {
        snapshots.push({
          relativePath: change.relativePath,
          absolutePath,
          existed: true,
          content: await readFile(absolutePath),
        });
      } catch (error) {
        if (!isMissing(error)) throw error;
        snapshots.push({ relativePath: change.relativePath, absolutePath, existed: false });
      }
    }
    for (const change of changes) {
      const absolutePath = resolve(targetRoot, change.relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, change.content, 'utf8');
    }
    return snapshots;
  }

  private async runPostPatchCommands(
    commands: Config['commands'],
    targetRoot: string,
  ): Promise<PassRecord['failures']> {
    const failures: PassRecord['failures'] = [];
    for (const [kind, command] of Object.entries(commands) as Array<
      [keyof Config['commands'], CommandSpec | null]
    >) {
      if (!command) continue;
      try {
        const result = await runAllowedProcess(
          this.dependencies.policy,
          command.executable,
          command.args,
          targetRoot,
        );
        if (result.exitCode !== 0) {
          failures.push({
            code: `${kind.toUpperCase()}_REGRESSION`,
            message: `${kind} command exited with ${result.exitCode}.`,
            recoverable: true,
          });
        }
      } catch (error) {
        failures.push({
          code: error instanceof SmartUiError ? error.code : `${kind.toUpperCase()}_FAILURE`,
          message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
          recoverable: true,
        });
      }
    }
    return failures;
  }
}

function makePassRecord(
  passIndex: number,
  captured: CapturedPass,
  transaction: PatchTransaction | null,
  reverted: boolean,
  failures: PassRecord['failures'],
): PassRecord {
  const record = passRecordSchema.parse({
    passIndex,
    findings: captured.comparison.findings,
    score: captured.comparison.score,
    changedFiles: transaction?.files ?? [],
    reverted,
    ...(transaction
      ? {
          proposal: {
            hash: transaction.hash,
            files: transaction.files,
            rationale: transaction.rationale,
          },
        }
      : {}),
    ...(captured.screenshot ? { screenshot: captured.screenshot } : {}),
    ...(captured.diff ? { diff: captured.diff } : {}),
    ...(captured.overlay ? { overlay: captured.overlay } : {}),
    timingsMs: captured.timings,
    failures,
  });
  return deepFreeze(record);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compactRepairInput(
  runId: string,
  contract: DesignContract,
  inspection: RepairProposalInput['inspection'],
  findings: ValidationFinding[],
  artifacts: ArtifactRef[],
  previousScores: number[],
  passIndex: number,
  maxCharacters: number,
): RepairProposalInput {
  const selected: ValidationFinding[] = [];
  for (const item of findings) {
    const candidate = {
      design: {
        id: contract.id,
        name: contract.name,
        viewport: contract.viewport,
        component: contract.component,
      },
      inspection,
      findings: [...selected, item],
      artifacts: uniqueArtifacts(artifacts),
      runId,
      previousScores,
      passIndex,
    };
    if (JSON.stringify(candidate).length > maxCharacters) break;
    selected.push(item);
  }
  if (findings.length > 0 && selected.length === 0) {
    throw new SmartUiError(
      'INVALID_INPUT',
      'A single diagnostic finding exceeds the configured context budget.',
    );
  }
  return {
    design: {
      id: contract.id,
      name: contract.name,
      viewport: contract.viewport,
      component: contract.component,
    },
    inspection,
    findings: selected,
    artifacts: uniqueArtifacts(artifacts),
    runId,
    previousScores,
    passIndex,
  };
}

function validateProposal(changes: ProposedChange[]): void {
  const paths = new Set<string>();
  for (const change of changes) {
    if (!change.relativePath || !change.rationale) {
      throw new SmartUiError('INVALID_INPUT', 'Every proposed change needs a path and rationale.');
    }
    if (paths.has(change.relativePath)) {
      throw new SmartUiError(
        'INVALID_INPUT',
        `Repair proposed duplicate writes to ${change.relativePath}.`,
      );
    }
    paths.add(change.relativePath);
  }
}

function hashProposal(changes: ProposedChange[]): string {
  const normalized = [...changes]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(({ relativePath, content }) => ({ relativePath, content }));
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

function signatureForFindings(findings: ValidationFinding[]): string {
  return createHash('sha256')
    .update(JSON.stringify(findings.map((item) => item.id).sort()))
    .digest('hex');
}

async function rollback(transaction: PatchTransaction): Promise<void> {
  for (const snapshot of [...transaction.snapshots].reverse()) {
    if (snapshot.existed && snapshot.content) {
      await mkdir(dirname(snapshot.absolutePath), { recursive: true });
      await writeFile(snapshot.absolutePath, snapshot.content);
    } else {
      try {
        await unlink(snapshot.absolutePath);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
}

async function assertNoSymlinkPath(targetRoot: string, relativePath: string): Promise<void> {
  const root = resolve(targetRoot);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
    throw new SmartUiError('POLICY_VIOLATION', `Path escapes target root: ${relativePath}`);
  }
  const segments = rel.split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          `Writable path contains a symbolic link: ${relativePath}`,
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      break;
    }
  }
}

function uniqueArtifacts(artifacts: ArtifactRef[]): ArtifactRef[] {
  return [...new Map(artifacts.map((artifact) => [artifact.hash, artifact])).values()];
}

function stopReasonFor(error: unknown): StopReason {
  if (error instanceof SmartUiError && error.code === 'POLICY_VIOLATION') return 'policy-violation';
  if (error instanceof SmartUiError && error.code === 'PROVIDER_FAILURE') return 'provider-failure';
  return 'provider-failure';
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
