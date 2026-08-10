import { z } from 'zod';

export const svgGenerationCorpusSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().min(1),
    license: z.string().min(1),
    provenance: z.string().min(1),
    scenarios: z
      .array(
        z
          .object({
            id: z.string().min(1),
            fixture: z.string().min(1),
            category: z.enum(['component', 'form', 'dashboard', 'marketing', 'adversarial']),
            requestedMode: z.enum(['exact', 'hybrid', 'semantic']),
            sourceViewport: z.string().min(1),
            narrowReferenceFixture: z.string().min(1).optional(),
            expectedSanitization: z.enum(['accepted', 'rejected']),
            traits: z.array(
              z.enum([
                'clean-text',
                'outlined-text',
                'mixed-raster-vector',
                'path-heavy',
                'exact-fallback',
                'hybrid-subtree',
                'desktop-only',
                'desktop-narrow-pair',
                'accessibility-sensitive',
                'unsafe',
              ]),
            ),
          })
          .strict(),
      )
      .min(10),
  })
  .strict();

export const svgGenerationObservationSchema = z
  .object({
    scenarioId: z.string().min(1),
    sanitization: z.object({ accepted: z.boolean(), reasonCodes: z.array(z.string()) }).strict(),
    requestedMode: z.enum(['exact', 'hybrid', 'semantic']),
    finalMode: z.enum(['exact', 'hybrid', 'semantic']).nullable(),
    terminalStatus: z.enum(['succeeded', 'completed-with-warnings', 'failed']),
    sourceFidelity: z.array(
      z
        .object({
          viewport: z.string().min(1),
          similarity: z.number().min(0).max(100),
          mismatchPercent: z.number().min(0).max(100),
        })
        .strict(),
    ),
    responsiveRobustness: z.array(
      z
        .object({ viewport: z.string().min(1), findingCount: z.number().int().nonnegative() })
        .strict(),
    ),
    structuralProperties: z
      .object({ checked: z.number().int().nonnegative(), passed: z.number().int().nonnegative() })
      .strict()
      .refine((value) => value.passed <= value.checked, 'passed cannot exceed checked'),
    runtimeFailures: z.number().int().nonnegative(),
    failedRequests: z.number().int().nonnegative(),
    accessibilityFindings: z.number().int().nonnegative(),
    generatedFiles: z.number().int().nonnegative(),
    generatedBytes: z.number().int().nonnegative(),
    timingsMs: z
      .object({ inspect: z.number().nonnegative(), total: z.number().nonnegative() })
      .strict(),
    peakEvidenceBytes: z.number().int().nonnegative(),
    repeatabilityHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
    repeatable: z.boolean(),
    compatibility: z
      .object({
        cli: z.enum(['verified', 'not-run']),
        mcp: z.enum(['verified', 'not-run']),
        studio: z.enum(['verified', 'not-run']),
      })
      .strict(),
  })
  .strict();

export const svgGenerationThresholdsSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    minimumSanitizationAccuracy: z.number().min(0).max(1),
    minimumSafeCompletionRate: z.number().min(0).max(1),
    minimumMeasuredSourceSimilarity: z.number().min(0).max(100),
    minimumStructuralPassRate: z.number().min(0).max(1),
    maximumRuntimeFailures: z.number().int().nonnegative(),
    maximumFailedRequests: z.number().int().nonnegative(),
    maximumAccessibilityFindings: z.number().int().nonnegative(),
    maximumGeneratedBytes: z.number().int().positive(),
    maximumP95TotalMs: z.number().positive(),
    requiredRepeatabilityRate: z.number().min(0).max(1),
    minimumCompatibilityRate: z.number().min(0).max(1),
  })
  .strict();

export const svgGenerationScorecardSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    corpusId: z.string().min(1),
    generatedAt: z.string().datetime(),
    scenarioCount: z.number().int().positive(),
    measures: z.record(z.string(), z.number()),
    gates: z.array(
      z
        .object({
          name: z.string().min(1),
          passed: z.boolean(),
          actual: z.number(),
          threshold: z.number(),
          operator: z.enum(['min', 'max']),
        })
        .strict(),
    ),
    passed: z.boolean(),
    overallQualityScore: z.null(),
  })
  .strict();

export function evaluateSvgGeneration(
  corpusInput: unknown,
  observationsInput: unknown,
  thresholdsInput: unknown,
) {
  const corpus = svgGenerationCorpusSchema.parse(corpusInput);
  const observations = z.array(svgGenerationObservationSchema).parse(observationsInput);
  const thresholds = svgGenerationThresholdsSchema.parse(thresholdsInput);
  const expected = new Map(corpus.scenarios.map((scenario) => [scenario.id, scenario]));
  if (
    observations.length !== expected.size ||
    observations.some((observation) => !expected.delete(observation.scenarioId)) ||
    expected.size > 0
  ) {
    throw new Error('SVG generation observations must cover every corpus scenario exactly once.');
  }
  const byId = new Map(corpus.scenarios.map((scenario) => [scenario.id, scenario]));
  const safe = observations.filter(
    (observation) => byId.get(observation.scenarioId)?.expectedSanitization === 'accepted',
  );
  const measuredFidelity = safe.flatMap((observation) => observation.sourceFidelity);
  const checkedProperties = safe.reduce(
    (sum, observation) => sum + observation.structuralProperties.checked,
    0,
  );
  const passedProperties = safe.reduce(
    (sum, observation) => sum + observation.structuralProperties.passed,
    0,
  );
  const compatibilityChecks = observations.flatMap((observation) =>
    Object.values(observation.compatibility),
  );
  const measuredCompatibility = compatibilityChecks.filter((value) => value !== 'not-run');
  const sortedTotals = safe.map((observation) => observation.timingsMs.total).sort((a, b) => a - b);
  const measures = {
    sanitizationAccuracy: ratio(
      observations.filter(
        (observation) =>
          observation.sanitization.accepted ===
          (byId.get(observation.scenarioId)?.expectedSanitization === 'accepted'),
      ).length,
      observations.length,
    ),
    safeCompletionRate: ratio(
      safe.filter((observation) => observation.terminalStatus !== 'failed').length,
      safe.length,
    ),
    minimumMeasuredSourceSimilarity:
      measuredFidelity.length > 0
        ? Math.min(...measuredFidelity.map((item) => item.similarity))
        : 0,
    structuralPassRate: ratio(passedProperties, checkedProperties),
    runtimeFailures: sum(safe.map((observation) => observation.runtimeFailures)),
    failedRequests: sum(safe.map((observation) => observation.failedRequests)),
    accessibilityFindings: sum(safe.map((observation) => observation.accessibilityFindings)),
    maximumGeneratedBytes: Math.max(0, ...safe.map((observation) => observation.generatedBytes)),
    p95TotalMs: percentile95(sortedTotals),
    repeatabilityRate: ratio(
      safe.filter((observation) => observation.repeatable).length,
      safe.length,
    ),
    compatibilityRate: ratio(
      measuredCompatibility.filter((value) => value === 'verified').length,
      measuredCompatibility.length,
    ),
    compatibilityChecks: measuredCompatibility.length,
    sourceFidelityViewportCount: measuredFidelity.length,
    responsiveRobustnessViewportCount: sum(
      safe.map((observation) => observation.responsiveRobustness.length),
    ),
  };
  const gates = [
    gate(
      'sanitizationAccuracy',
      measures.sanitizationAccuracy,
      thresholds.minimumSanitizationAccuracy,
      'min',
    ),
    gate(
      'safeCompletionRate',
      measures.safeCompletionRate,
      thresholds.minimumSafeCompletionRate,
      'min',
    ),
    gate(
      'minimumMeasuredSourceSimilarity',
      measures.minimumMeasuredSourceSimilarity,
      thresholds.minimumMeasuredSourceSimilarity,
      'min',
    ),
    gate(
      'structuralPassRate',
      measures.structuralPassRate,
      thresholds.minimumStructuralPassRate,
      'min',
    ),
    gate('runtimeFailures', measures.runtimeFailures, thresholds.maximumRuntimeFailures, 'max'),
    gate('failedRequests', measures.failedRequests, thresholds.maximumFailedRequests, 'max'),
    gate(
      'accessibilityFindings',
      measures.accessibilityFindings,
      thresholds.maximumAccessibilityFindings,
      'max',
    ),
    gate(
      'maximumGeneratedBytes',
      measures.maximumGeneratedBytes,
      thresholds.maximumGeneratedBytes,
      'max',
    ),
    gate('p95TotalMs', measures.p95TotalMs, thresholds.maximumP95TotalMs, 'max'),
    gate(
      'repeatabilityRate',
      measures.repeatabilityRate,
      thresholds.requiredRepeatabilityRate,
      'min',
    ),
    gate(
      'compatibilityRate',
      measures.compatibilityRate,
      thresholds.minimumCompatibilityRate,
      'min',
    ),
  ];
  return svgGenerationScorecardSchema.parse({
    schemaVersion: '1.0',
    corpusId: corpus.id,
    generatedAt: new Date().toISOString(),
    scenarioCount: observations.length,
    measures,
    gates,
    passed: gates.every((item) => item.passed),
    overallQualityScore: null,
  });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percentile95(values: number[]): number {
  return values.length === 0 ? 0 : values[Math.max(0, Math.ceil(values.length * 0.95) - 1)]!;
}

function gate(name: string, actual: number, threshold: number, operator: 'min' | 'max') {
  return {
    name,
    actual,
    threshold,
    operator,
    passed: operator === 'min' ? actual >= threshold : actual <= threshold,
  };
}
