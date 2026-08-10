import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Review, StudioApp } from '../apps/studio/src/client.js';

describe('Studio frontend components', () => {
  it('renders an accessible four-step local upload workflow', () => {
    const html = renderToStaticMarkup(createElement(StudioApp));
    expect(html).toContain('Smart UI Studio');
    expect(html).toContain('aria-label="Generation steps"');
    expect(html).toContain('Choose or drop an SVG');
    expect(html).toContain('telemetry off');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('renders review evidence, source as escaped text, downloads, and an isolated sandboxed preview', () => {
    const run = {
      runId: 'run-11111111-1111-1111-1111-111111111111',
      filename: 'screen.svg',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      phase: 'completed' as const,
      progress: { stage: 'completed', value: 1, message: 'Done' },
      generation: {
        generationId: 'generation-11111111-1111-1111-1111-111111111111',
        status: 'succeeded',
        stoppedReason: 'success',
        requestedMode: 'hybrid' as const,
        finalMode: 'hybrid' as const,
        files: [
          {
            index: 0,
            relativePath: 'index.html',
            mediaType: 'text/html',
            hash: `sha256:${'a'.repeat(64)}`,
            byteLength: 50,
          },
        ],
        visualSimilarity: 99.5,
        visualMismatchPercent: 0.5,
        uncertaintyCount: 0,
        uncertainties: [],
        findings: [],
        viewports: [
          {
            name: 'narrow',
            viewport: { width: 375, height: 600 },
            classification: 'responsive-robustness',
            findingCount: 0,
          },
        ],
        warnings: [],
        failures: [],
        previewUrl: 'http://127.0.0.1:43210/index.html',
        downloads: { archive: '/archive', report: '/report' },
        evidence: { screenshot: '/screenshot', diff: '/diff', overlay: '/overlay' },
      },
    };
    const html = renderToStaticMarkup(
      createElement(Review, {
        run,
        source: {
          relativePath: 'index.html',
          mediaType: 'text/html',
          source: '<script>alert(1)</script>',
        },
        onSource: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    expect(html).toContain('sandbox=""');
    expect(html).toContain('Robustness only; no false fidelity score');
    expect(html).toContain('&lt;script');
    expect(html).toContain('&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Delete this run');
  });
});
