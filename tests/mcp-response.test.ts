import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRunResponse } from '../apps/mcp-server/src/server.js';
import { runRecordSchema, type RunRecord } from '../packages/core/src/index.js';
import { EMPTY_HASH } from './helpers.js';

describe('compact MCP run response', () => {
  it('preserves targeting values, visual convergence, and paged retrieval guidance', () => {
    const artifact = {
      hash: EMPTY_HASH,
      mediaType: 'image/png',
      relativePath: 'objects/evidence.png',
      byteLength: 0,
    };
    const runArtifact = {
      ...artifact,
      mediaType: 'application/json',
      relativePath: 'objects/run.json',
    };
    const findings: RunRecord['passes'][number]['findings'] = [
      finding('geometry', 'width', '[data-validation-id="card"]', 320, 300),
      finding('geometry', 'padding', '[data-validation-id="card"]', 24, 16),
      finding('typography', 'fontSize', '[data-validation-id="title"]', 20, 18),
      finding('appearance', 'backgroundColor', '[data-validation-id="card"]', '#fff', '#eee'),
      finding('runtime', 'console_error', undefined, 'no console errors', 'token=secret-value'),
      finding('raster', 'raster_difference', undefined, 0.75, 12.5),
    ];
    const record = runRecordSchema.parse({
      schemaVersion: '1.0',
      id: 'run-targeted-findings',
      status: 'succeeded',
      startedAt: '2026-08-10T00:00:00.000Z',
      completedAt: '2026-08-10T00:00:01.000Z',
      targetRoot: resolve('.'),
      designContract: 'design.json',
      inputs: { url: 'http://127.0.0.1:4173', designId: 'design' },
      decisions: [],
      targetArtifact: artifact,
      artifacts: [artifact, runArtifact],
      changedFiles: [],
      timingsMs: { total: 1 },
      warnings: [],
      failures: [],
      provenance: { tool: 'smart-ui', version: '0.5.0' },
      score: 50,
      stoppedReason: 'validation-only',
      passes: [
        {
          passIndex: 0,
          findings,
          score: 50,
          diffPercent: 12.5,
          changedFiles: [],
          reverted: false,
          screenshot: artifact,
          diff: artifact,
          overlay: artifact,
          timingsMs: { capture: 1 },
          failures: [],
        },
      ],
    });

    const compact = formatRunResponse(
      {
        record,
        report: null,
        repair: {
          mode: 'validation-only',
          provider: null,
          acceptedChangeCount: 0,
          behavior: 'No source changes were requested.',
        },
      },
      { targetRoot: resolve('.'), artifactRoot: resolve('.smart-ui-test-artifacts') },
      'compact',
    ) as {
      visualMismatchPercent: number;
      findingSamples: Array<Record<string, unknown>>;
      findingRetrieval: Record<string, unknown>;
    };

    expect(compact.visualMismatchPercent).toBe(12.5);
    expect(compact.findingSamples).toHaveLength(5);
    expect(compact.findingSamples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'geometry',
          targetDomLocator: '[data-validation-id="card"]',
          expected: 320,
          actual: 300,
          delta: 20,
        }),
        expect.objectContaining({ category: 'typography' }),
        expect.objectContaining({ category: 'appearance' }),
        expect.objectContaining({ category: 'runtime', actual: 'token=[REDACTED]' }),
        expect.objectContaining({ category: 'raster' }),
      ]),
    );
    expect(compact.findingRetrieval).toMatchObject({
      sampled: 5,
      total: 6,
      hasMore: true,
      tool: 'get_findings',
      arguments: { path: expect.stringMatching(/objects[\\/]run\.json$/u) },
    });
  });
});

function finding(
  category: RunRecord['passes'][number]['findings'][number]['category'],
  repair: string,
  targetDomLocator: string | undefined,
  expected: unknown,
  actual: unknown,
): RunRecord['passes'][number]['findings'][number] {
  return {
    id: `finding-${category}-${repair}`,
    category,
    severity: 'error',
    confidence: 1,
    ...(targetDomLocator ? { targetDomLocator } : {}),
    expected,
    actual,
    ...(typeof expected === 'number' && typeof actual === 'number'
      ? { delta: Math.abs(expected - actual) }
      : {}),
    message: `${repair} mismatch`,
    suggestedRepairCategory: repair,
    evidenceArtifacts: [],
  };
}
