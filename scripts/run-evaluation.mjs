import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateRelease } from '../packages/core/dist/evaluation.js';

const [
  corpusPath = 'evaluations/corpus.v1.json',
  observationsPath = 'evaluations/observations.v1.json',
  thresholdsPath = 'evaluations/release-thresholds.v1.json',
  outputPath = 'evaluation-scorecard.json',
] = process.argv.slice(2);
const readJson = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'));
const scorecard = evaluateRelease(
  await readJson(corpusPath),
  await readJson(observationsPath),
  await readJson(thresholdsPath),
);
await writeFile(resolve(outputPath), `${JSON.stringify(scorecard, null, 2)}\n`);
console.log(JSON.stringify(scorecard, null, 2));
if (!scorecard.passed) process.exitCode = 3;
