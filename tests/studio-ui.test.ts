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
      rounds: [],
      selectedRound: null,
      acceptedRound: null,
      decision: null,
      pendingAuthoring: null,
      generation: {
        generationId: 'generation-11111111-1111-1111-1111-111111111111',
        status: 'succeeded',
        stoppedReason: 'success',
        engine: 'deterministic' as const,
        agent: null,
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
        evidence: {
          screenshot: '/screenshot',
          design: '/design',
          diff: '/diff',
          overlay: '/overlay',
        },
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
        feedback: '',
        busy: false,
        onFeedback: vi.fn(),
        onDecide: vi.fn(),
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
    expect(html).not.toContain('Ask the agent to improve');
  });

  it('offers accept and bounded improve actions with per-round evidence while awaiting a decision', () => {
    const run = {
      runId: 'run-22222222-2222-2222-2222-222222222222',
      filename: 'screen.svg',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      phase: 'awaiting-decision' as const,
      progress: { stage: 'awaiting-decision', value: 1, message: 'Round 2 is ready.' },
      rounds: [
        {
          round: 1,
          createdAt: new Date(0).toISOString(),
          engine: 'agent' as const,
          authoringAgent: 'chat-agent',
          feedback: null,
          responseHash: `sha256:${'b'.repeat(64)}`,
          visualSimilarity: 91.25,
          visualMismatchPercent: 8.75,
          accepted: false,
        },
        {
          round: 2,
          createdAt: new Date(0).toISOString(),
          engine: 'agent' as const,
          authoringAgent: 'chat-agent',
          feedback: 'Tighten the header spacing.',
          responseHash: `sha256:${'c'.repeat(64)}`,
          visualSimilarity: 97.5,
          visualMismatchPercent: 2.5,
          accepted: false,
        },
      ],
      selectedRound: 2,
      acceptedRound: null,
      decision: { canImprove: true, remainingImproveRounds: 4, maxImproveRounds: 5 },
      pendingAuthoring: null,
      generation: {
        generationId: 'generation-22222222-2222-2222-2222-222222222222',
        status: 'succeeded',
        stoppedReason: 'success',
        engine: 'agent' as const,
        agent: { host: 'studio-agent:chat-agent', accepted: true },
        requestedMode: 'semantic' as const,
        finalMode: 'semantic' as const,
        files: [],
        visualSimilarity: 97.5,
        visualMismatchPercent: 2.5,
        uncertaintyCount: 0,
        uncertainties: [],
        findings: [],
        viewports: [],
        warnings: [],
        failures: [],
        previewUrl: null,
        downloads: { archive: null, report: null },
        evidence: null,
      },
    };
    const html = renderToStaticMarkup(
      createElement(Review, {
        run,
        source: undefined,
        feedback: 'Tighten the header spacing.',
        busy: false,
        onFeedback: vi.fn(),
        onDecide: vi.fn(),
        onSource: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    expect(html).toContain('Accept round 2');
    expect(html).toContain('Ask the agent to improve');
    expect(html).toContain('Accept round 1');
    expect(html).toContain('91.250% similarity');
    expect(html).toContain('4 improvement round(s) remain.');
  });
});
