import { z } from 'zod';

export const evaluationObservationSchema = z
  .object({
    scenarioId: z.string().min(1),
    framework: z.enum(['react', 'angular']),
    fidelity: z
      .object({
        geometry: z.number().min(0).max(100),
        typography: z.number().min(0).max(100),
        color: z.number().min(0).max(100),
        asset: z.number().min(0).max(100),
        aggregate: z.number().min(0).max(100),
      })
      .strict(),
    componentCorrect: z.boolean(),
    reusedExistingPrimitive: z.boolean(),
    responsiveCoveragePercent: z.number().min(0).max(100),
    interactionCoveragePercent: z.number().min(0).max(100),
    accessibilityErrors: z.number().int().nonnegative(),
    accessibilityRegressions: z.number().int().nonnegative(),
    repairPasses: z.number().int().nonnegative(),
    converged: z.boolean(),
    rolledBack: z.boolean(),
    contextCharacters: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    latencyMs: z.number().nonnegative(),
    browserTimeMs: z.number().nonnegative(),
    artifactBytes: z.number().int().nonnegative(),
    memoryPrecision: z.number().min(0).max(1),
    leakageAttemptsBlocked: z.number().int().nonnegative(),
    leakageAttempts: z.number().int().nonnegative(),
    injectionAttemptsBlocked: z.number().int().nonnegative(),
    injectionAttempts: z.number().int().nonnegative(),
  })
  .strict();

export const evaluationCorpusSchema = z
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
            framework: z.enum(['react', 'angular']),
            design: z.string().min(1),
            target: z.string().min(1),
            states: z.array(z.string()),
            viewports: z.array(z.string()),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();

export const releaseThresholdsSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    minimumAggregateFidelity: z.number().min(0).max(100),
    minimumComponentCorrectnessRate: z.number().min(0).max(1),
    minimumReuseRate: z.number().min(0).max(1),
    minimumResponsiveCoveragePercent: z.number().min(0).max(100),
    minimumInteractionCoveragePercent: z.number().min(0).max(100),
    maximumAccessibilityRegressions: z.number().int().nonnegative(),
    minimumConvergenceRate: z.number().min(0).max(1),
    maximumRollbackRate: z.number().min(0).max(1),
    maximumEstimatedTokens: z.number().int().positive(),
    maximumP95LatencyMs: z.number().positive(),
    minimumMemoryPrecision: z.number().min(0).max(1),
    requiredLeakageBlockRate: z.number().min(0).max(1),
    requiredInjectionBlockRate: z.number().min(0).max(1),
  })
  .strict();

export const evaluationScorecardSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    corpusId: z.string().min(1),
    generatedAt: z.string().datetime(),
    scenarioCount: z.number().int().positive(),
    metrics: z.record(z.string(), z.number()),
    gates: z.array(
      z
        .object({
          name: z.string(),
          passed: z.boolean(),
          actual: z.number(),
          threshold: z.number(),
          operator: z.enum(['min', 'max']),
        })
        .strict(),
    ),
    passed: z.boolean(),
  })
  .strict();

export function evaluateRelease(
  corpusInput: unknown,
  observationsInput: unknown,
  thresholdsInput: unknown,
) {
  const corpus = evaluationCorpusSchema.parse(corpusInput);
  const observations = z.array(evaluationObservationSchema).parse(observationsInput);
  const thresholds = releaseThresholdsSchema.parse(thresholdsInput);
  const expected = new Set(corpus.scenarios.map((scenario) => scenario.id));
  if (
    observations.length !== expected.size ||
    observations.some((item) => !expected.delete(item.scenarioId)) ||
    expected.size > 0
  ) {
    throw new Error('Evaluation observations must cover every corpus scenario exactly once.');
  }
  const average = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const ratio = (passed: number, total: number) => (total === 0 ? 1 : passed / total);
  const sortedLatencies = observations.map((item) => item.latencyMs).sort((a, b) => a - b);
  const metrics = {
    aggregateFidelity: average(observations.map((item) => item.fidelity.aggregate)),
    componentCorrectnessRate: ratio(
      observations.filter((item) => item.componentCorrect).length,
      observations.length,
    ),
    reuseRate: ratio(
      observations.filter((item) => item.reusedExistingPrimitive).length,
      observations.length,
    ),
    responsiveCoveragePercent: average(observations.map((item) => item.responsiveCoveragePercent)),
    interactionCoveragePercent: average(
      observations.map((item) => item.interactionCoveragePercent),
    ),
    accessibilityRegressions: observations.reduce(
      (sum, item) => sum + item.accessibilityRegressions,
      0,
    ),
    convergenceRate: ratio(
      observations.filter((item) => item.converged).length,
      observations.length,
    ),
    rollbackRate: ratio(observations.filter((item) => item.rolledBack).length, observations.length),
    estimatedTokens: observations.reduce((sum, item) => sum + item.estimatedTokens, 0),
    p95LatencyMs: sortedLatencies[Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1)]!,
    memoryPrecision: average(observations.map((item) => item.memoryPrecision)),
    leakageBlockRate: ratio(
      observations.reduce((sum, item) => sum + item.leakageAttemptsBlocked, 0),
      observations.reduce((sum, item) => sum + item.leakageAttempts, 0),
    ),
    injectionBlockRate: ratio(
      observations.reduce((sum, item) => sum + item.injectionAttemptsBlocked, 0),
      observations.reduce((sum, item) => sum + item.injectionAttempts, 0),
    ),
  };
  const gates = [
    gate(
      'aggregateFidelity',
      metrics.aggregateFidelity,
      thresholds.minimumAggregateFidelity,
      'min',
    ),
    gate(
      'componentCorrectnessRate',
      metrics.componentCorrectnessRate,
      thresholds.minimumComponentCorrectnessRate,
      'min',
    ),
    gate('reuseRate', metrics.reuseRate, thresholds.minimumReuseRate, 'min'),
    gate(
      'responsiveCoveragePercent',
      metrics.responsiveCoveragePercent,
      thresholds.minimumResponsiveCoveragePercent,
      'min',
    ),
    gate(
      'interactionCoveragePercent',
      metrics.interactionCoveragePercent,
      thresholds.minimumInteractionCoveragePercent,
      'min',
    ),
    gate(
      'accessibilityRegressions',
      metrics.accessibilityRegressions,
      thresholds.maximumAccessibilityRegressions,
      'max',
    ),
    gate('convergenceRate', metrics.convergenceRate, thresholds.minimumConvergenceRate, 'min'),
    gate('rollbackRate', metrics.rollbackRate, thresholds.maximumRollbackRate, 'max'),
    gate('estimatedTokens', metrics.estimatedTokens, thresholds.maximumEstimatedTokens, 'max'),
    gate('p95LatencyMs', metrics.p95LatencyMs, thresholds.maximumP95LatencyMs, 'max'),
    gate('memoryPrecision', metrics.memoryPrecision, thresholds.minimumMemoryPrecision, 'min'),
    gate('leakageBlockRate', metrics.leakageBlockRate, thresholds.requiredLeakageBlockRate, 'min'),
    gate(
      'injectionBlockRate',
      metrics.injectionBlockRate,
      thresholds.requiredInjectionBlockRate,
      'min',
    ),
  ];
  return evaluationScorecardSchema.parse({
    schemaVersion: '1.0',
    corpusId: corpus.id,
    generatedAt: new Date().toISOString(),
    scenarioCount: observations.length,
    metrics,
    gates,
    passed: gates.every((item) => item.passed),
  });
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
