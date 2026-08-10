import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateSvgGeneration } from '../packages/core/dist/generation-evaluation.js';

const [
  corpusPath = 'evaluations/svg-generation-corpus.v1.json',
  observationsPath = 'evaluations/svg-generation-observations.v1.json',
  thresholdsPath = 'evaluations/svg-generation-thresholds.v1.json',
  outputPath = 'svg-generation-scorecard.json',
] = process.argv.slice(2);
const readJson = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'));
const scorecard = evaluateSvgGeneration(
  await readJson(corpusPath),
  await readJson(observationsPath),
  await readJson(thresholdsPath),
);
await writeFile(resolve(outputPath), `${JSON.stringify(scorecard, null, 2)}\n`);
console.log(JSON.stringify(scorecard, null, 2));
if (!scorecard.passed) process.exitCode = 3;
