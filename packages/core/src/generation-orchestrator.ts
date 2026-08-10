import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Config } from './config.js';
import { SmartUiComparator } from './comparator.js';
import { parseColor } from './color.js';
import {
  generationRecordSchema,
  svgGenerationInputSchema,
  type DesignBundleNode,
  type GeneratedHtmlBundle,
  type GenerationRecord,
  type GenerationStopReason,
  type SanitizationSummary,
  type SvgGenerationInput,
} from './generation-contracts.js';
import type {
  GeneratedPreviewProvider,
  GenerationExporter,
  GenerationReporter,
  HtmlGenerationProvider,
  SvgStructureProvider,
} from './generation-providers.js';
import { validateGeneratedBundle } from './generated-output.js';
import { generatedManifestHash } from './host-proposed-generation.js';
import { inferControlBounds } from './html-generation-provider.js';
import { SmartUiError } from './errors.js';
import type { ArtifactStore, BrowserEvidence, BrowserProvider } from './providers.js';
import {
  designContractSchema,
  validationFindingSchema,
  type ArtifactRef,
  type DesignElement,
  type ValidationFinding,
} from './schemas.js';

export interface GenerationOrchestratorDependencies {
  structure: SvgStructureProvider;
  generator: HtmlGenerationProvider;
  fallbackGenerator?: HtmlGenerationProvider;
  preview: GeneratedPreviewProvider;
  browser: BrowserProvider;
  artifacts: ArtifactStore;
  reporter: GenerationReporter;
  exporter: GenerationExporter;
  config: Config;
  tool?: 'smart-ui' | 'smart-ui-mcp' | 'smart-ui-studio';
  /**
   * How an approved host/agent proposal competes with the deterministic fallback.
   * 'non-regression' (default) keeps the proposal only when it does not regress the fallback's
   * score or visual mismatch. 'prefer-proposal' keeps any valid, non-repeated proposal while still
   * recording honest deterministic comparison evidence for both passes.
   */
  proposalPolicy?: 'non-regression' | 'prefer-proposal';
  onProgress?: (event: {
    stage: 'sanitize' | 'generate' | 'preview' | 'compare' | 'package' | 'report' | 'export';
    progress: number;
    message: string;
  }) => Promise<void> | void;
}

export interface GenerationResult {
  record: GenerationRecord;
  recordArtifact: ArtifactRef;
  exportedFiles: string[];
}

interface EvaluatedBundle {
  bundle: GeneratedHtmlBundle;
  provider: HtmlGenerationProvider;
  comparison: Awaited<ReturnType<SmartUiComparator['compare']>>;
  screenshot: ArtifactRef;
  reference: ArtifactRef;
  diff: ArtifactRef;
  overlay: ArtifactRef;
  outputHash: string;
  viewports: GenerationRecord['viewports'];
  artifacts: ArtifactRef[];
  previewMs: number;
  compareMs: number;
}

export class GenerationOrchestrator {
  constructor(private readonly dependencies: GenerationOrchestratorDependencies) {}

  async run(inputValue: SvgGenerationInput, signal?: AbortSignal): Promise<GenerationResult> {
    const input = svgGenerationInputSchema.parse(inputValue);
    if (input.rendering.background.kind === 'color') {
      try {
        parseColor(input.rendering.background.value);
      } catch (error) {
        throw new SmartUiError(
          'INVALID_INPUT',
          error instanceof Error ? error.message : 'Invalid rendering background color.',
        );
      }
    }
    const startedAt = new Date().toISOString();
    const started = performance.now();
    await assertWorkspace(input.workspaceRoot);
    await assertRunPath(input.workspaceRoot, input.artifactRoot, 'Artifact root');
    if (input.exportRoot) {
      await assertContainedPath(input.workspaceRoot, input.exportRoot, 'Export root');
      await assertEmptyDirectory(input.exportRoot, 'Export root');
      if (pathsOverlap(input.artifactRoot, input.exportRoot)) {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          'Artifact and export roots must not contain one another.',
        );
      }
    }
    const timeoutMs = input.timeoutMs ?? this.dependencies.config.generation.timeoutMs;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, timeoutMs);
    try {
      return await this.execute(input, startedAt, started, controller.signal);
    } catch (error) {
      return this.failure(input, startedAt, started, error, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  private async execute(
    input: SvgGenerationInput,
    startedAt: string,
    started: number,
    signal: AbortSignal,
  ): Promise<GenerationResult> {
    abort(signal);
    await this.progress('sanitize', 0.05, 'Sanitizing and inspecting SVG evidence.');
    const inspectionStarted = performance.now();
    const inspection = await this.dependencies.structure.inspect(input, signal);
    const inspectMs = performance.now() - inspectionStarted;
    const designBundle = await this.dependencies.artifacts.put(
      new TextEncoder().encode(`${JSON.stringify(inspection.bundle)}\n`),
      'application/json',
      'design-bundle.json',
    );
    const baseArtifacts: ArtifactRef[] = [inspection.bundle.sanitizedSvg, designBundle];
    const generationId = input.generationId ?? `generation-${randomUUID()}`;
    if (input.dryRun) {
      const preliminary = generationRecordSchema.parse({
        schemaVersion: '1.0',
        generatorVersion: this.dependencies.generator.version,
        id: generationId,
        status: 'dry-run',
        startedAt,
        completedAt: new Date().toISOString(),
        stoppedReason: 'dry-run',
        originalInputHash: inspection.bundle.originalInputHash,
        sanitizedHash: inspection.bundle.sanitizedHash,
        sanitizedSource: inspection.bundle.sanitizedSvg,
        designBundle,
        sanitization: inspection.bundle.sanitization,
        input: recordInput(input, inspection.bundle.name, inspection.bundle.viewport),
        provider: {
          name: this.dependencies.generator.name,
          version: this.dependencies.generator.version,
        },
        generatedFiles: [],
        decisions: [...inspection.bundle.layoutCandidates, ...inspection.bundle.semanticCandidates],
        uncertainties: inspection.bundle.uncertainties,
        passes: [],
        viewports: [],
        artifacts: baseArtifacts,
        timingsMs: { inspect: inspectMs, total: performance.now() - started },
        warnings: inspection.bundle.uncertainties.map((item) => item.message),
        failures: [],
        canceled: false,
        provenance: { tool: this.dependencies.tool ?? 'smart-ui', hostProposal: false },
      });
      return this.finalize(preliminary, input, [], false, signal);
    }

    abort(signal);
    await this.progress('generate', 0.2, 'Generating a bounded offline HTML bundle.');
    const generationStarted = performance.now();
    const proposed = await this.dependencies.generator.generate(input, inspection, signal);
    validateOutput(proposed, this.dependencies.config.generation.limits);
    const hostProposal = this.dependencies.generator.hostProposal;
    const fallbackProvider = hostProposal ? this.dependencies.fallbackGenerator : undefined;
    const fallback = fallbackProvider
      ? await fallbackProvider.generate(input, inspection, signal)
      : undefined;
    if (fallback) validateOutput(fallback, this.dependencies.config.generation.limits);
    const referenceProvider = fallbackProvider ?? this.dependencies.generator;
    const exactReference = await referenceProvider.generate(
      { ...input, mode: 'exact' },
      inspection,
      signal,
    );
    validateOutput(exactReference, this.dependencies.config.generation.limits);
    const generateMs = performance.now() - generationStarted;
    const artifacts = [...baseArtifacts];

    const viewport = inspection.bundle.viewport;
    const browserOptions = {
      viewport,
      timeoutMs: Math.min(this.dependencies.config.generation.timeoutMs, 60_000),
      locale: input.rendering.locale,
      theme: input.rendering.theme,
      allowedEndpoints: [] as string[],
      blockExternalNetwork: true,
      screenshotBeforeFocusProbe: true,
      signal,
      evidenceLimits: this.dependencies.config.evidence,
    };
    await this.progress('preview', 0.35, 'Rendering the sanitized SVG reference in isolation.');
    const referenceSession = await this.dependencies.preview.serve(exactReference, signal);
    let referenceEvidence: BrowserEvidence;
    try {
      referenceEvidence = await this.dependencies.browser.capture({
        ...browserOptions,
        url: referenceSession.url,
        allowedEndpoints: [referenceSession.origin],
      });
    } finally {
      await referenceSession.close();
    }
    const referenceRaster = await this.dependencies.artifacts.put(
      referenceEvidence.screenshot,
      'image/png',
      'reference-raster.png',
    );
    artifacts.push(referenceRaster);
    const baselineEvaluation = fallback
      ? await this.evaluate(
          input,
          inspection,
          fallback,
          fallbackProvider!,
          referenceEvidence,
          referenceRaster,
          browserOptions,
          'baseline',
          signal,
        )
      : undefined;
    const proposedEvaluation = await this.evaluate(
      input,
      inspection,
      proposed,
      this.dependencies.generator,
      referenceEvidence,
      referenceRaster,
      browserOptions,
      hostProposal ? 'proposal' : 'generated',
      signal,
    );
    artifacts.push(...(baselineEvaluation?.artifacts ?? []), ...proposedEvaluation.artifacts);

    const requestedPasses = input.maxPasses ?? this.dependencies.config.generation.maxPasses;
    const repeatedOutput = Boolean(
      baselineEvaluation && baselineEvaluation.outputHash === proposedEvaluation.outputHash,
    );
    const proposalAccepted = baselineEvaluation
      ? requestedPasses > 0 &&
        !repeatedOutput &&
        (this.dependencies.proposalPolicy === 'prefer-proposal' ||
          (proposedEvaluation.comparison.score >= baselineEvaluation.comparison.score &&
            proposedEvaluation.comparison.diffPercent <=
              baselineEvaluation.comparison.diffPercent +
                this.dependencies.config.generation.maxProposalRegressionPercent))
      : true;
    const accepted =
      proposalAccepted || !baselineEvaluation ? proposedEvaluation : baselineEvaluation;
    const acceptedBundle = accepted.bundle;
    const acceptedProvider = accepted.provider;
    const generatedFiles = [];
    for (const file of acceptedBundle.files) {
      abort(signal);
      const artifact = await this.dependencies.artifacts.put(
        file.bytes,
        file.mediaType,
        file.relativePath,
      );
      artifacts.push(artifact);
      generatedFiles.push({
        relativePath: file.relativePath,
        mediaType: file.mediaType,
        hash: hash(file.bytes),
        byteLength: file.bytes.byteLength,
        artifact,
        rationale: file.rationale,
        sourceNodeIds: file.sourceNodeIds,
      });
    }
    if (hostProposal && !proposalAccepted) {
      for (const file of proposed.files) {
        artifacts.push(
          await this.dependencies.artifacts.put(
            file.bytes,
            file.mediaType,
            `rejected-proposal-${file.relativePath}`,
          ),
        );
      }
    }
    const manifestHash = generatedManifestHash(generatedFiles);
    await this.progress('package', 0.85, 'Packaging the accepted manifest reproducibly.');
    const archiveBytes = await this.dependencies.exporter.archive(acceptedBundle.files, signal);
    const archive = await this.dependencies.artifacts.put(
      archiveBytes,
      'application/zip',
      'generated-ui.zip',
    );
    artifacts.push(archive);
    const warnings = [
      ...acceptedBundle.uncertainties.map((item) => item.message),
      ...accepted.comparison.findings
        .filter((finding) => finding.severity !== 'info')
        .map((finding) => finding.message),
      ...(hostProposal && !proposalAccepted
        ? [
            repeatedOutput
              ? 'The host proposal repeated the deterministic baseline output and was not retained.'
              : 'The host proposal regressed deterministic source fidelity or structural checks and was not retained.',
          ]
        : []),
    ];
    const stoppedReason: GenerationStopReason = baselineEvaluation
      ? proposalAccepted
        ? 'success'
        : repeatedOutput
          ? 'repeated-output'
          : requestedPasses === 0
            ? 'maximum-passes'
            : 'no-improvement'
      : acceptedBundle.finalMode === 'exact' && input.mode !== 'exact'
        ? 'exact-fallback'
        : 'success';
    const passes = baselineEvaluation
      ? [
          passRecord(baselineEvaluation, 0, !proposalAccepted, false),
          passRecord(proposedEvaluation, 1, proposalAccepted, !proposalAccepted),
        ]
      : [passRecord(proposedEvaluation, 0, true, false)];
    const preliminary = generationRecordSchema.parse({
      schemaVersion: '1.0',
      generatorVersion: acceptedProvider.version,
      id: generationId,
      status: warnings.length > 0 ? 'completed-with-warnings' : 'succeeded',
      startedAt,
      completedAt: new Date().toISOString(),
      stoppedReason,
      originalInputHash: inspection.bundle.originalInputHash,
      sanitizedHash: inspection.bundle.sanitizedHash,
      sanitizedSource: inspection.bundle.sanitizedSvg,
      designBundle,
      sanitization: inspection.bundle.sanitization,
      input: recordInput(input, inspection.bundle.name, viewport, acceptedBundle.finalMode),
      provider: {
        name: acceptedProvider.name,
        version: acceptedProvider.version,
      },
      generatedFiles,
      manifestHash,
      decisions: [
        ...acceptedBundle.decisions,
        ...(hostProposal && !proposalAccepted
          ? [
              {
                kind: 'host-proposal-rejected',
                message:
                  'Core validation retained the deterministic fallback because the approved host proposal did not satisfy the configured non-regression boundary.',
                sourceNodeIds: [],
                confidence: 1,
                provenance: `${hostProposal.host}:${hostProposal.proposalHash}`,
              },
            ]
          : []),
      ],
      uncertainties: acceptedBundle.uncertainties,
      passes,
      viewports: accepted.viewports,
      artifacts,
      archive,
      timingsMs: {
        inspect: inspectMs,
        generate: generateMs,
        preview: proposedEvaluation.previewMs + (baselineEvaluation?.previewMs ?? 0),
        compare: proposedEvaluation.compareMs + (baselineEvaluation?.compareMs ?? 0),
        total: performance.now() - started,
      },
      warnings: [...new Set(warnings)],
      failures: [],
      canceled: false,
      provenance: {
        tool: this.dependencies.tool ?? 'smart-ui',
        hostProposal: Boolean(hostProposal),
        ...(hostProposal
          ? {
              hostProposalAccepted: proposalAccepted,
              host: hostProposal.host,
              proposalHash: hostProposal.proposalHash,
            }
          : {}),
      },
    });
    return this.finalize(
      preliminary,
      input,
      acceptedBundle.files,
      Boolean(input.exportRoot),
      signal,
    );
  }

  private async evaluate(
    input: SvgGenerationInput,
    inspection: Awaited<ReturnType<SvgStructureProvider['inspect']>>,
    bundle: GeneratedHtmlBundle,
    provider: HtmlGenerationProvider,
    referenceEvidence: BrowserEvidence,
    referenceRaster: ArtifactRef,
    browserOptions: Omit<Parameters<BrowserProvider['capture']>[0], 'url'>,
    label: string,
    signal: AbortSignal,
  ): Promise<EvaluatedBundle> {
    abort(signal);
    await this.progress('preview', 0.5, `Rendering ${label} output in isolated Chromium.`);
    const previewStarted = performance.now();
    const session = await this.dependencies.preview.serve(bundle, signal);
    let evidence: BrowserEvidence;
    const viewports: GenerationRecord['viewports'] = [];
    const artifacts: ArtifactRef[] = [];
    try {
      evidence = await this.dependencies.browser.capture({
        ...browserOptions,
        url: session.url,
        allowedEndpoints: [session.origin],
      });
      if (
        input.layout === 'responsive' &&
        this.dependencies.config.generation.narrowViewportWidth < inspection.bundle.viewport.width
      ) {
        const width = this.dependencies.config.generation.narrowViewportWidth;
        const narrowViewport = {
          width,
          height: Math.max(
            1,
            Math.ceil(
              (inspection.bundle.viewport.height * width) / inspection.bundle.viewport.width,
            ),
          ),
          deviceScaleFactor: inspection.bundle.viewport.deviceScaleFactor,
        };
        const narrow = await this.dependencies.browser.capture({
          ...browserOptions,
          url: session.url,
          viewport: narrowViewport,
          allowedEndpoints: [session.origin],
        });
        const narrowScreenshot = await this.dependencies.artifacts.put(
          narrow.screenshot,
          'image/png',
          `${label}-responsive-narrow.png`,
        );
        artifacts.push(narrowScreenshot);
        viewports.push({
          name: 'narrow',
          viewport: narrowViewport,
          classification: 'responsive-robustness',
          screenshot: narrowScreenshot,
          findings: responsiveFindings(
            narrow,
            narrowViewport.width,
            inspection.bundle.sanitizedSvg,
          ),
        });
      }
    } finally {
      await session.close();
    }
    const previewMs = performance.now() - previewStarted;
    abort(signal);
    await this.progress('compare', 0.7, `Comparing ${label} output deterministically.`);
    const contract = generationContract(input, inspection, bundle, referenceRaster);
    const comparisonStarted = performance.now();
    const comparison = await new SmartUiComparator(this.dependencies.config).compare(
      contract,
      evidence,
      { bytes: referenceEvidence.screenshot, mediaType: 'image/png' },
      signal,
    );
    if (!comparison.diff || !comparison.overlay) {
      throw new SmartUiError(
        'PROVIDER_FAILURE',
        'Generation comparison did not produce visual evidence.',
      );
    }
    const screenshot = await this.dependencies.artifacts.put(
      evidence.screenshot,
      'image/png',
      `${label}-generated.png`,
    );
    const diff = await this.dependencies.artifacts.put(
      comparison.diff,
      'image/png',
      `${label}-diff.png`,
    );
    const overlay = await this.dependencies.artifacts.put(
      comparison.overlay,
      'image/png',
      `${label}-overlay.png`,
    );
    artifacts.push(screenshot, diff, overlay);
    viewports.unshift({
      name: 'source',
      viewport: inspection.bundle.viewport,
      classification: 'source-fidelity',
      screenshot,
      similarity: Math.max(0, 100 - comparison.diffPercent),
      diffPercent: comparison.diffPercent,
      findings: comparison.findings,
    });
    return {
      bundle,
      provider,
      comparison,
      screenshot,
      reference: referenceRaster,
      diff,
      overlay,
      outputHash: bundleHash(bundle),
      viewports,
      artifacts,
      previewMs,
      compareMs: performance.now() - comparisonStarted,
    };
  }

  private async progress(
    stage: Parameters<NonNullable<GenerationOrchestratorDependencies['onProgress']>>[0]['stage'],
    progress: number,
    message: string,
  ): Promise<void> {
    await this.dependencies.onProgress?.({ stage, progress, message });
  }

  private async failure(
    input: SvgGenerationInput,
    startedAt: string,
    started: number,
    error: unknown,
    canceled: boolean,
  ): Promise<GenerationResult> {
    const details = error instanceof SmartUiError ? error.details : undefined;
    const originalHash =
      typeof details?.['originalHash'] === 'string'
        ? details['originalHash']
        : hash(new Uint8Array());
    const sanitization = isSanitizationSummary(details?.['sanitization'])
      ? details['sanitization']
      : emptySanitization();
    const stoppedReason = failureReason(error, canceled, details?.['stoppedReason']);
    const message =
      error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
    const preliminary = generationRecordSchema.parse({
      schemaVersion: '1.0',
      generatorVersion: this.dependencies.generator.version,
      id: input.generationId ?? `generation-${randomUUID()}`,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      stoppedReason,
      originalInputHash: originalHash,
      sanitization,
      input: recordInput(input, input.name ?? 'SVG generation', input.viewport),
      provider: {
        name: this.dependencies.generator.name,
        version: this.dependencies.generator.version,
      },
      generatedFiles: [],
      decisions: [],
      uncertainties: [],
      passes: [],
      viewports: [],
      artifacts: [],
      timingsMs: { total: performance.now() - started },
      warnings: [],
      failures: [
        {
          code: error instanceof SmartUiError ? error.code : 'UNEXPECTED',
          message,
          recoverable: false,
        },
      ],
      canceled,
      provenance: {
        tool: this.dependencies.tool ?? 'smart-ui',
        hostProposal: Boolean(this.dependencies.generator.hostProposal),
        ...(this.dependencies.generator.hostProposal
          ? {
              hostProposalAccepted: false,
              host: this.dependencies.generator.hostProposal.host,
              proposalHash: this.dependencies.generator.hostProposal.proposalHash,
            }
          : {}),
      },
    });
    return this.finalize(preliminary, input, [], false, undefined);
  }

  private async finalize(
    preliminary: GenerationRecord,
    input: SvgGenerationInput,
    files: GeneratedHtmlBundle['files'],
    exportRequested: boolean,
    signal?: AbortSignal,
  ): Promise<GenerationResult> {
    await this.progress('report', 0.92, 'Writing the offline generation report.');
    const report = await this.dependencies.reporter.write(preliminary, signal);
    const record = generationRecordSchema.parse({
      ...preliminary,
      report,
      artifacts: [...preliminary.artifacts, report],
    });
    const recordArtifact = await this.dependencies.artifacts.put(
      new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
      'application/json',
      `${record.id}.json`,
    );
    const exportedFiles =
      exportRequested && input.exportRoot
        ? (await this.progress('export', 0.97, 'Materializing the separately approved export.'),
          await this.dependencies.exporter.materialize(input.exportRoot, files, signal))
        : [];
    return { record, recordArtifact, exportedFiles };
  }
}

function generationContract(
  input: SvgGenerationInput,
  inspection: Awaited<ReturnType<SvgStructureProvider['inspect']>>,
  generated: GeneratedHtmlBundle,
  referenceRaster: ArtifactRef,
) {
  const viewport = inspection.bundle.viewport;
  return designContractSchema.parse({
    schemaVersion: '1.0',
    id: inspection.bundle.id,
    name: inspection.bundle.name,
    viewport,
    theme: input.rendering.theme,
    locale: input.rendering.locale,
    component: { name: inspection.bundle.name, route: '/' },
    reference: referenceRaster,
    provenance: {
      provider: inspection.bundle.provenance.provider,
      source: input.svgPath,
      capturedAt: inspection.bundle.capturedAt,
      sourceHash: inspection.bundle.sanitizedHash,
      sourceVersion: inspection.bundle.provenance.version,
    },
    ambiguities: inspection.bundle.uncertainties.map((item) => item.message),
    elements:
      generated.finalMode === 'exact'
        ? []
        : inspection.bundle.scene.nodes.flatMap((node) =>
            projectSemanticNode(node, inspection.bundle.scene.nodes, viewport),
          ),
    sourceEvidence: {
      assets: [],
      uncertainties: inspection.bundle.uncertainties.map((item) => item.message),
    },
  });
}

function passRecord(
  evaluated: EvaluatedBundle,
  passIndex: number,
  accepted: boolean,
  reverted: boolean,
): GenerationRecord['passes'][number] {
  return {
    passIndex,
    outputHash: evaluated.outputHash,
    findings: evaluated.comparison.findings,
    score: evaluated.comparison.score,
    diffPercent: evaluated.comparison.diffPercent,
    screenshot: evaluated.screenshot,
    reference: evaluated.reference,
    diff: evaluated.diff,
    overlay: evaluated.overlay,
    provider: { name: evaluated.provider.name, version: evaluated.provider.version },
    accepted,
    reverted,
    ...(evaluated.provider.hostProposal
      ? { proposalHash: evaluated.provider.hostProposal.proposalHash }
      : {}),
    timingsMs: { preview: evaluated.previewMs, compare: evaluated.compareMs },
  };
}

function bundleHash(bundle: GeneratedHtmlBundle): string {
  return hash(
    new TextEncoder().encode(
      bundle.files
        .map((file) => `${file.relativePath}\0${file.mediaType}\0${hash(file.bytes)}`)
        .sort()
        .join('\n'),
    ),
  );
}

function projectSemanticNode(
  node: DesignBundleNode,
  nodes: DesignBundleNode[],
  viewport: { width: number; height: number },
): DesignElement[] {
  if (node.type !== 'text' || !node.text || !node.bounds || node.transform) return [];
  const size = Number.parseFloat(node.computedStyle['font-size'] ?? '16');
  const controlBounds = inferControlBounds(nodes, node, viewport);
  const bounds = controlBounds ?? node.bounds;
  return [
    {
      validationId: validationId(node.id),
      sourceNodeId: node.id,
      type: controlBounds ? 'button' : Number.isFinite(size) && size >= 24 ? 'heading' : 'p',
      x: bounds.x,
      y: bounds.y,
      ...(bounds.width > 0 ? { width: bounds.width } : {}),
      height: bounds.height,
      color: node.computedStyle['fill'] ?? '#000',
      fontSize: Number.isFinite(size) && size > 0 ? size : 16,
      fontWeight: node.computedStyle['font-weight'] ?? '400',
      text: node.text,
      role: controlBounds ? 'button' : Number.isFinite(size) && size >= 24 ? 'heading' : 'generic',
      ...(controlBounds
        ? { accessibleName: node.text, keyboardReachable: true, focusVisible: true }
        : {}),
    },
  ];
}

function validationId(sourceNodeId: string): string {
  return `svg-${createHash('sha256').update(sourceNodeId).digest('hex').slice(0, 16)}`;
}

function responsiveFindings(
  evidence: BrowserEvidence,
  viewportWidth: number,
  artifact: ArtifactRef,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const element of evidence.elements) {
    if (element.x < -1 || element.x + element.width > viewportWidth + 1) {
      findings.push(
        validationFindingSchema.parse({
          id: findingId('responsive-overflow', element.selector),
          category: 'geometry',
          severity: 'warning',
          confidence: 1,
          targetDomLocator: element.validationId ?? element.selector,
          expected: `within ${viewportWidth}px viewport`,
          actual: { x: element.x, width: element.width },
          message: `Element overflows the narrow responsive viewport: ${element.selector}`,
          suggestedRepairCategory: 'responsive_overflow',
          evidenceArtifacts: [artifact],
        }),
      );
    }
    if (
      ['button', 'a', 'input', 'select', 'textarea'].includes(element.tagName.toLowerCase()) &&
      (element.width < 44 || element.height < 44)
    ) {
      findings.push(
        validationFindingSchema.parse({
          id: findingId('responsive-target-size', element.selector),
          category: 'accessibility',
          severity: 'warning',
          confidence: 1,
          targetDomLocator: element.validationId ?? element.selector,
          expected: { minimumWidth: 44, minimumHeight: 44 },
          actual: { width: element.width, height: element.height },
          message: `Interactive target is smaller than 44×44 CSS pixels: ${element.selector}`,
          suggestedRepairCategory: 'minimum_target_size',
          evidenceArtifacts: [artifact],
        }),
      );
    }
  }
  const focusable = evidence.elements.filter((element) => element.keyboardReachable);
  for (let index = 1; index < focusable.length; index++) {
    const previous = focusable[index - 1]!;
    const current = focusable[index]!;
    if (current.y + 1 < previous.y && current.x + 1 < previous.x) {
      findings.push(
        validationFindingSchema.parse({
          id: findingId('responsive-focus-order', current.selector),
          category: 'accessibility',
          severity: 'warning',
          confidence: 0.8,
          targetDomLocator: current.validationId ?? current.selector,
          expected: 'DOM focus order follows visual reading order',
          actual: `${previous.selector} -> ${current.selector}`,
          message: 'Keyboard focus order may diverge from the narrow visual reading order.',
          suggestedRepairCategory: 'focus_order',
          evidenceArtifacts: [artifact],
        }),
      );
      break;
    }
  }
  for (const message of evidence.consoleErrors) {
    findings.push(runtimeFinding('console_error', message, artifact));
  }
  for (const message of evidence.failedRequests) {
    findings.push(runtimeFinding('network_failure', message, artifact));
  }
  for (const violation of evidence.accessibilityViolations ?? []) {
    findings.push(
      validationFindingSchema.parse({
        id: findingId(violation.rule, violation.selector),
        category: 'accessibility',
        severity: 'warning',
        confidence: 1,
        targetDomLocator: violation.selector,
        message: `${violation.rule}: ${violation.message}`,
        suggestedRepairCategory: violation.rule,
        evidenceArtifacts: [artifact],
      }),
    );
  }
  return findings;
}

function runtimeFinding(code: string, message: string, artifact: ArtifactRef): ValidationFinding {
  return validationFindingSchema.parse({
    id: findingId(code, message),
    category: 'runtime',
    severity: 'warning',
    confidence: 1,
    message,
    suggestedRepairCategory: code,
    evidenceArtifacts: [artifact],
  });
}

function findingId(kind: string, value: string): string {
  return `generation-${createHash('sha256').update(`${kind}\0${value}`).digest('hex').slice(0, 20)}`;
}

function recordInput(
  input: SvgGenerationInput,
  name: string,
  viewport: SvgGenerationInput['viewport'],
  finalMode?: SvgGenerationInput['mode'],
) {
  return {
    name,
    requestedMode: input.mode,
    ...(finalMode ? { finalMode } : {}),
    layout: input.layout,
    ...(viewport ? { viewport } : {}),
    renderingBackground:
      input.rendering.background.kind === 'color'
        ? input.rendering.background.value
        : 'transparent',
    ...(input.instructions
      ? { instructionsHash: hash(new TextEncoder().encode(input.instructions)) }
      : {}),
  };
}

async function assertRunPath(workspaceRoot: string, path: string, label: string): Promise<void> {
  await assertContainedPath(workspaceRoot, path, label);
  await assertEmptyDirectory(path, label);
}

async function assertEmptyDirectory(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(path)).length > 0) {
      throw new SmartUiError('POLICY_VIOLATION', `${label} must be a new empty directory.`);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

async function assertWorkspace(workspaceRoot: string): Promise<void> {
  let info;
  try {
    info = await lstat(resolve(workspaceRoot));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new SmartUiError('INVALID_INPUT', 'Declared workspace does not exist.');
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SmartUiError('POLICY_VIOLATION', 'Declared workspace must be a regular directory.');
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  const leftToRight = relative(leftPath, rightPath);
  const rightToLeft = relative(rightPath, leftPath);
  return (
    leftPath === rightPath ||
    (!leftToRight.startsWith('..') && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !isAbsolute(rightToLeft))
  );
}

async function assertContainedPath(
  workspaceRoot: string,
  path: string,
  label: string,
): Promise<void> {
  const workspace = resolve(workspaceRoot);
  const target = resolve(path);
  const rel = relative(workspace, target);
  if (rel.startsWith('..') || isAbsolute(rel) || target === workspace) {
    throw new SmartUiError('POLICY_VIOLATION', `${label} escapes the declared workspace.`);
  }
  let current = workspace;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new SmartUiError('POLICY_VIOLATION', `${label} crosses a symbolic link.`);
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}

function failureReason(error: unknown, canceled: boolean, detail: unknown): GenerationStopReason {
  if (canceled) return 'canceled';
  if (typeof detail === 'string') {
    const parsed = [
      'invalid-svg',
      'unsafe-svg',
      'invalid-output',
      'policy-violation',
      'provider-failure',
    ].find((value) => value === detail);
    if (parsed) return parsed as GenerationStopReason;
  }
  if (error instanceof SmartUiError && error.code === 'POLICY_VIOLATION') return 'policy-violation';
  if (error instanceof SmartUiError && error.code === 'INVALID_INPUT') return 'invalid-svg';
  return 'provider-failure';
}

function emptySanitization(): SanitizationSummary {
  return {
    accepted: false,
    nodeCount: 0,
    maxDepth: 0,
    attributeCount: 0,
    pathDataCharacters: 0,
    gradientCount: 0,
    filterCount: 0,
    embeddedImageCount: 0,
    embeddedImageBytes: 0,
    decisions: [],
    rejectionCodes: [],
  };
}

function validateOutput(bundle: GeneratedHtmlBundle, limits: Config['generation']['limits']): void {
  try {
    validateGeneratedBundle(bundle, limits);
  } catch (error) {
    throw new SmartUiError(
      error instanceof SmartUiError ? error.code : 'PROVIDER_FAILURE',
      error instanceof Error ? error.message : String(error),
      { stoppedReason: 'invalid-output' },
    );
  }
}

function isSanitizationSummary(value: unknown): value is SanitizationSummary {
  return Boolean(value && typeof value === 'object' && 'accepted' in value && 'nodeCount' in value);
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new SmartUiError('PROVIDER_FAILURE', 'SVG generation was canceled.');
}
