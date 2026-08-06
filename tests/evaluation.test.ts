import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { evaluateRelease } from '../packages/core/src/index.js';

const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

describe('versioned release evaluation', () => {
  it('covers React and Angular and enforces every release threshold', async () => {
    const corpus = await json('evaluations/corpus.v1.json');
    const scorecard = evaluateRelease(
      corpus,
      await json('evaluations/observations.v1.json'),
      await json('evaluations/release-thresholds.v1.json'),
    );
    expect(
      new Set(corpus.scenarios.map((scenario: { framework: string }) => scenario.framework)),
    ).toEqual(new Set(['react', 'angular']));
    expect(scorecard.passed).toBe(true);
    expect(scorecard.gates.every((gate) => gate.passed)).toBe(true);
  });

  it('fails a regressed fidelity gate and rejects incomplete corpora', async () => {
    const corpus = await json('evaluations/corpus.v1.json');
    const observations = await json('evaluations/observations.v1.json');
    const thresholds = await json('evaluations/release-thresholds.v1.json');
    observations[0].fidelity.aggregate = 0;
    expect(evaluateRelease(corpus, observations, thresholds).passed).toBe(false);
    expect(() => evaluateRelease(corpus, observations.slice(0, 1), thresholds)).toThrow(
      /every corpus scenario/,
    );
  });
});
