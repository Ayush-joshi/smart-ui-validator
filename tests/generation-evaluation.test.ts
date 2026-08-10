import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateSvgGeneration, svgGenerationScorecardSchema } from '../packages/core/src/index.js';

describe('SVG generation pilot evaluation', () => {
  it('reports separate deterministic measures without inventing an overall quality score', async () => {
    const scorecard = evaluateSvgGeneration(
      await json('evaluations/svg-generation-corpus.v1.json'),
      await json('evaluations/svg-generation-observations.v1.json'),
      await json('evaluations/svg-generation-thresholds.v1.json'),
    );
    expect(svgGenerationScorecardSchema.parse(scorecard)).toEqual(scorecard);
    expect(scorecard.passed).toBe(true);
    expect(scorecard.overallQualityScore).toBeNull();
    expect(scorecard.scenarioCount).toBe(12);
    expect(scorecard.measures).toMatchObject({
      sanitizationAccuracy: 1,
      safeCompletionRate: 1,
      repeatabilityRate: 1,
      compatibilityRate: 1,
      sourceFidelityViewportCount: 10,
      responsiveRobustnessViewportCount: 8,
    });
    expect(scorecard.gates.every((gate) => gate.passed)).toBe(true);
  });

  it('rejects partial observations instead of silently changing the corpus denominator', async () => {
    const observations = (await json(
      'evaluations/svg-generation-observations.v1.json',
    )) as unknown[];
    const corpus = await json('evaluations/svg-generation-corpus.v1.json');
    const thresholds = await json('evaluations/svg-generation-thresholds.v1.json');
    expect(() => evaluateSvgGeneration(corpus, observations.slice(1), thresholds)).toThrow(
      /cover every corpus scenario exactly once/u,
    );
  });
});

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}
