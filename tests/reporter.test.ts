import { dirname, normalize, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { HtmlReporter, LocalArtifactStore, runRecordSchema } from '../packages/core/src/index.js';
import { PNG_BYTES } from './helpers.js';

describe('offline HTML report', () => {
  it('links content-addressed evidence from the report object directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'smart-ui-report-'));
    const store = new LocalArtifactStore(root);
    const image = await store.put(PNG_BYTES, 'image/png', 'target.png');
    const record = runRecordSchema.parse({
      schemaVersion: '1.0',
      id: 'report-test',
      status: 'succeeded',
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: '2026-08-06T00:00:01.000Z',
      targetRoot: '/tmp/target',
      designContract: 'design.json',
      inputs: { url: 'http://127.0.0.1:4173', designId: 'design' },
      decisions: [],
      targetArtifact: image,
      artifacts: [image],
      changedFiles: [],
      timingsMs: { total: 1 },
      warnings: [],
      failures: [],
      provenance: { tool: 'smart-ui', version: '0.2.0' },
      score: 90,
      stoppedReason: 'validation-only',
      passes: [
        {
          passIndex: 0,
          findings: [
            {
              id: 'missing-element',
              category: 'geometry',
              severity: 'error',
              confidence: 1,
              expected: 'card-title',
              message: 'Expected element is missing.',
              suggestedRepairCategory: 'missing_element',
              evidenceArtifacts: [image],
            },
          ],
          score: 90,
          changedFiles: [],
          reverted: false,
          screenshot: image,
          diff: image,
          overlay: image,
          timingsMs: { capture: 1 },
          failures: [],
        },
      ],
    });

    const report = await new HtmlReporter(store).write(record);
    const html = new TextDecoder().decode(await store.read(report.relativePath));
    const href = html.match(/<img src="([^"]+)"/)?.[1];
    expect(href).toBeDefined();
    expect(normalize(resolve(dirname(report.relativePath), href!))).toBe(
      normalize(resolve(image.relativePath)),
    );
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('Actual: <code>undefined</code>');
  });
});
