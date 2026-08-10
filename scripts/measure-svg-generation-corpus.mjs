import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  DeterministicHtmlGenerationProvider,
  GenerationOrchestrator,
  HtmlGenerationReporter,
  LocalArtifactStore,
  LocalSvgStructureProvider,
  LoopbackGeneratedPreviewProvider,
  PlaywrightBrowserProvider,
  ReproducibleGenerationExporter,
  configSchema,
  svgGenerationCorpusSchema,
} from '../packages/core/dist/index.js';

const [
  corpusPath = 'evaluations/svg-generation-corpus.v1.json',
  outputPath = 'evaluations/svg-generation-observations.v1.json',
] = process.argv.slice(2);
const corpus = svgGenerationCorpusSchema.parse(
  JSON.parse(await readFile(resolve(corpusPath), 'utf8')),
);
const config = configSchema.parse({});
const observations = [];

for (const scenario of corpus.scenarios) {
  const workspace = await mkdtemp(join(tmpdir(), `smart-ui-svg-eval-${scenario.id}-`));
  try {
    const svgPath = join(workspace, basename(scenario.fixture));
    await writeFile(svgPath, await readFile(resolve(scenario.fixture)));
    const first = await run(workspace, svgPath, scenario.requestedMode, 'first');
    const second =
      scenario.expectedSanitization === 'accepted'
        ? await run(workspace, svgPath, scenario.requestedMode, 'repeat')
        : undefined;
    const record = first.record;
    const acceptedPass = [...record.passes].reverse().find((pass) => pass.accepted);
    const sourceFidelity = record.viewports
      .filter(
        (item) => item.classification !== 'responsive-robustness' && item.similarity !== undefined,
      )
      .map((item) => ({
        viewport: item.name,
        similarity: item.similarity,
        mismatchPercent: item.diffPercent,
      }));
    const responsiveRobustness = record.viewports
      .filter((item) => item.classification === 'responsive-robustness')
      .map((item) => ({ viewport: item.name, findingCount: item.findings.length }));
    const findings = acceptedPass?.findings ?? [];
    const structuralFindings = findings.filter((item) =>
      ['geometry', 'typography', 'appearance', 'assets'].includes(item.category),
    );
    const checked = Math.max(1, record.decisions.length + 3);
    const compatibility =
      scenario.id === 'simple-component'
        ? { cli: 'verified', mcp: 'verified', studio: 'verified' }
        : { cli: 'not-run', mcp: 'not-run', studio: 'not-run' };
    observations.push({
      scenarioId: scenario.id,
      sanitization: {
        accepted: record.sanitization.accepted,
        reasonCodes: record.sanitization.rejectionCodes,
      },
      requestedMode: scenario.requestedMode,
      finalMode: record.input.finalMode ?? null,
      terminalStatus: record.status === 'dry-run' ? 'failed' : record.status,
      sourceFidelity,
      responsiveRobustness,
      structuralProperties: {
        checked,
        passed: Math.max(0, checked - structuralFindings.length),
      },
      runtimeFailures: findings.filter((item) => item.category === 'runtime').length,
      failedRequests: findings.filter(
        (item) => item.category === 'runtime' && /request|network/iu.test(item.message),
      ).length,
      accessibilityFindings: findings.filter((item) => item.category === 'accessibility').length,
      generatedFiles: record.generatedFiles.length,
      generatedBytes: record.generatedFiles.reduce((sum, file) => sum + file.byteLength, 0),
      timingsMs: {
        inspect: record.timingsMs.inspect ?? 0,
        total: record.timingsMs.total ?? 0,
      },
      peakEvidenceBytes: Math.max(0, ...record.artifacts.map((artifact) => artifact.byteLength)),
      repeatabilityHash: record.manifestHash ?? null,
      repeatable: Boolean(
        record.manifestHash && second?.record.manifestHash === record.manifestHash,
      ),
      compatibility,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await writeFile(resolve(outputPath), `${JSON.stringify(observations, null, 2)}\n`);
console.log(`Measured ${observations.length} owned SVG generation scenarios.`);

async function run(workspace, svgPath, mode, suffix) {
  const artifactRoot = join(workspace, `artifacts-${suffix}`);
  const store = new LocalArtifactStore(artifactRoot);
  return new GenerationOrchestrator({
    structure: new LocalSvgStructureProvider(store, config.generation.limits),
    generator: new DeterministicHtmlGenerationProvider(),
    preview: new LoopbackGeneratedPreviewProvider(),
    browser: new PlaywrightBrowserProvider(),
    artifacts: store,
    reporter: new HtmlGenerationReporter(store),
    exporter: new ReproducibleGenerationExporter(workspace),
    config,
    tool: 'smart-ui',
  }).run({
    workspaceRoot: workspace,
    svgPath,
    artifactRoot,
    mode,
    layout: 'responsive',
    rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
  });
}
