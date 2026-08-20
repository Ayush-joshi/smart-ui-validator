import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CanvasEditor,
  connectedHandoffInstructions,
  DesignReferenceInput,
  DesignContextFileEditor,
  hasRecentWork,
  Review,
  portableHandoffInstructions,
  shouldResetWorkflow,
  StructuredContextEditor,
  StudioApp,
} from '../apps/studio/src/client.js';

describe('Studio frontend components', () => {
  it('builds self-contained connected and portable handoff instructions', () => {
    const task = {
      taskId: 'task-11111111-1111-1111-1111-111111111111',
      taskType: 'validate-ui' as const,
      taskHash: `sha256:${'a'.repeat(64)}`,
      taskFile: 'C:\\repo\\.smart-ui\\validate-ui-tasks\\task-1\\task.json',
      status: 'pending',
      revision: 3,
      activeAttempt: null,
      acceptedAttempt: null,
      writableFiles: ['src/app/dashboard.component.ts', 'src/app/dashboard.component.html'],
      route: 'http://127.0.0.1:4200/dashboard',
      attempt: null,
      commands: {
        review: 'smart-ui validate-ui review --task "C:\\repo\\task.json"',
        status: '',
        accept: '',
        cancel: '',
        mcp: '',
      },
    };
    const connected = connectedHandoffInstructions(task);
    const portable = portableHandoffInstructions(task);

    for (const instructions of [connected, portable]) {
      expect(instructions).toContain(task.taskFile);
      expect(instructions).toContain(task.taskHash);
      expect(instructions).toContain('Revision: 3');
      expect(instructions).toContain('src/app/dashboard.component.ts');
      expect(instructions).toContain('src/app/dashboard.component.html');
      expect(instructions).toContain('Do not modify or submit any other path');
    }
    expect(connected).toContain('submit_handoff_implementation');
    expect(portable).toContain(task.commands.review);
  });

  it('opens with accessible Generate UI and Validate UI work choices', () => {
    const html = renderToStaticMarkup(createElement(StudioApp));
    expect(html).toContain('Smart UI Studio');
    expect(html).toContain('What are you working on?');
    expect(html).toContain('Generate UI');
    expect(html).toContain('Validate UI');
    expect(html).toContain('Target required');
    expect(html).not.toContain('aria-label="Studio workflow steps"');
    expect(html).toContain('telemetry off');
    expect(html).toContain('Reset workflow');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('treats returning to Step 1 as a non-destructive workflow reset', () => {
    expect(shouldResetWorkflow('work-type')).toBe(true);
  });

  it('does not reset client state when navigating between active workflow steps', () => {
    expect(shouldResetWorkflow('inputs')).toBe(false);
    expect(shouldResetWorkflow('boundaries')).toBe(false);
    expect(shouldResetWorkflow('handoff')).toBe(false);
    expect(shouldResetWorkflow('review')).toBe(false);
  });

  it('shows persisted work separately from the active workflow', () => {
    expect(hasRecentWork(0, 0)).toBe(false);
    expect(hasRecentWork(1, 0)).toBe(true);
    expect(hasRecentWork(0, 1)).toBe(true);
  });

  it('uses one SVG and PNG dropzone for generated and validated design references', () => {
    const file = new File(['<svg/>'], 'checkout.svg', { type: 'image/svg+xml' });
    const html = renderToStaticMarkup(
      createElement(DesignReferenceInput, {
        file,
        busy: false,
        maxBytes: 4_000,
        onFile: vi.fn(),
      }),
    );
    expect(html).toContain('class="dropzone"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/svg+xml,image/png,.svg,.png"');
    expect(html).toContain('checkout.svg');
    expect(html).not.toContain('target-relative');
  });

  it('offers an optional UTF-8 design context file for the connected agent', () => {
    const html = renderToStaticMarkup(
      createElement(DesignContextFileEditor, {
        context: null,
        maxBytes: 256_000,
        disabled: false,
        onFile: vi.fn(),
      }),
    );
    expect(html).toContain('Design context file');
    expect(html).toContain('class="dropzone"');
    expect(html).toContain('Choose or drop design context');
    expect(html).toContain('UTF-8 text file · maximum 250.0 KB');
    expect(html).toContain('Boundaries design context source');
    expect(html).toContain('Paste or type');
    expect(html).toContain('JSX, TSX, HTML, CSS, JSON, Markdown');
    expect(html).toContain(
      'connected agent receives this file together with the SVG or PNG evidence',
    );
  });

  it('renders accessible typed-context and exact-canvas editors', () => {
    const canvas = renderToStaticMarkup(
      createElement(CanvasEditor, {
        sourceWidth: 320,
        sourceHeight: 180,
        custom: true,
        width: 640,
        height: 360,
        dpr: 2,
        fit: 'contain',
        horizontalAlignment: 'center',
        verticalAlignment: 'end',
        viewports: [],
        onCustom: vi.fn(),
        onWidth: vi.fn(),
        onHeight: vi.fn(),
        onDpr: vi.fn(),
        onFit: vi.fn(),
        onHorizontalAlignment: vi.fn(),
        onVerticalAlignment: vi.fn(),
        onViewports: vi.fn(),
      }),
    );
    const context = renderToStaticMarkup(
      createElement(StructuredContextEditor, {
        value: {
          schemaVersion: '1.0',
          exactCopy: [
            {
              id: 'title',
              label: 'Title',
              text: 'Hello',
              locale: 'en-US',
              sourceNodeIds: ['text-1'],
              provenance: 'studio:user',
            },
          ],
          designTokens: [],
          componentSemantics: [],
          interactions: [],
        },
        onChange: vi.fn(),
      }),
    );
    expect(canvas).toContain('Primary canvas width');
    expect(canvas).toContain('Device pixel ratio');
    expect(canvas).toContain('Named validation viewports');
    expect(context).toContain('Structured design context');
    expect(context).toContain('Exact copy');
    expect(context).toContain('Locale');
    expect(context).toContain('Source node IDs (comma separated)');
    expect(context).toContain('Component semantics');
    expect(context).toContain('Interactions');
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

  it('explains failed scoring instead of presenting a blank metric', () => {
    const run = {
      runId: 'run-33333333-3333-4333-8333-333333333333',
      filename: 'broken.svg',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      phase: 'failed' as const,
      progress: { stage: 'failed', value: 1, message: 'Generation failed.' },
      rounds: [],
      selectedRound: 1,
      acceptedRound: null,
      decision: null,
      pendingAuthoring: null,
      generation: {
        generationId: 'generation-33333333-3333-4333-8333-333333333333',
        status: 'failed',
        stoppedReason: 'failed',
        engine: 'agent' as const,
        agent: { host: 'studio-agent:chat-agent', accepted: false },
        requestedMode: 'semantic' as const,
        files: [],
        visualSimilarity: null,
        visualMismatchPercent: null,
        uncertaintyCount: 0,
        uncertainties: [],
        findings: [],
        viewports: [],
        warnings: [],
        failures: [{ code: 'POLICY_VIOLATION', message: 'Generated CSS is invalid.' }],
        previewUrl: null,
        downloads: { archive: null, report: null },
        evidence: null,
      },
    };
    const html = renderToStaticMarkup(
      createElement(Review, {
        run,
        source: undefined,
        feedback: '',
        busy: false,
        onFeedback: vi.fn(),
        onDecide: vi.fn(),
        onSource: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    expect(html).toContain('This round could not be scored.');
    expect(html).toContain('Generated CSS is invalid.');
    expect(html).toContain('Unavailable — generation failed');
  });
});
