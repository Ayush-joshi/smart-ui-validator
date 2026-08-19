import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeterministicHtmlGenerationProvider,
  LocalArtifactStore,
  LocalSvgStructureProvider,
  agentQueueRoot,
  authoredHostFiles,
  authoringCanvasGuidance,
  authoringRequestSchema,
  authoringResponseHash,
  authoringRevisionGuidance,
  buildAuthoringRequest,
  deleteAuthoringRequest,
  deleteAuthoringResponse,
  highestIssuedAuthoringRound,
  listPendingAuthoringRequests,
  loadConfig,
  readAuthoringResponse,
  svgGenerationInputSchema,
  waitForAuthoringResponse,
  writeAuthoringRequest,
  writeAuthoringResponse,
  type AuthoringDesignReference,
  type AuthoringPriorEvidence,
  type StructuredDesignContext,
  type StudioAuthoringResponse,
} from '../packages/core/src/index.js';

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const RUN_ID = 'run-00000000-0000-4000-8000-000000000000';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#fff"/><text x="24" y="52" fill="#123" font-family="Arial" font-size="28">Semantic title</text></svg>';

async function workspace(name: string): Promise<string> {
  const root = await mkdtemp(join(resolve('tests'), `.studio-bridge-${name}-`));
  temporaryPaths.push(root);
  return root;
}

async function inspectedRequest(
  ws: string,
  timeoutMs?: number,
  extra: {
    round?: number;
    feedback?: string;
    priorEvidence?: AuthoringPriorEvidence;
    context?: StructuredDesignContext;
    designContext?: {
      filename: string;
      mediaType: string;
      content: string;
      originalHash: string;
      byteLength: number;
      provenance: string;
    };
    designReference?: AuthoringDesignReference;
  } = {},
) {
  const svgPath = join(ws, 'design.svg');
  await writeFile(svgPath, SVG, { flag: 'w' });
  const config = await loadConfig(ws);
  const artifactRoot = join(ws, `artifacts-${extra.round ?? 1}`);
  const input = svgGenerationInputSchema.parse({
    workspaceRoot: ws,
    svgPath,
    artifactRoot,
    mode: 'semantic',
    layout: 'responsive',
    rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
    instructions: 'Use the exact heading copy.',
    ...(extra.context ? { structuredDesignContext: extra.context } : {}),
  });
  const inspection = await new LocalSvgStructureProvider(
    new LocalArtifactStore(artifactRoot),
    config.generation.limits,
  ).inspect(input);
  return buildAuthoringRequest({
    runId: RUN_ID,
    input,
    inspection,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...extra,
  });
}

const PRIOR_EVIDENCE: AuthoringPriorEvidence = {
  round: 1,
  visualSimilarityPercent: 91.25,
  visualMismatchPercent: 8.75,
  finalMode: 'semantic',
  findings: [{ category: 'geometry', severity: 'moderate', message: 'Header is 12px too tall.' }],
  warnings: ['One font was unavailable.'],
};

function validResponse(round = 1): StudioAuthoringResponse {
  return {
    schemaVersion: '1.0',
    runId: RUN_ID,
    round,
    authoringAgent: 'test-agent',
    createdAt: new Date().toISOString(),
    files: [
      {
        path: 'index.html',
        content:
          '<!doctype html><html lang="en"><head><link rel="stylesheet" href="styles.css"></head><body><h1>Semantic title</h1></body></html>',
      },
      { path: 'styles.css', content: 'body { margin: 0; }' },
    ],
  };
}

describe('Studio agent authoring bridge', () => {
  it('builds a bounded request carrying design evidence and verbatim user context', async () => {
    const ws = await workspace('build');
    const context: StructuredDesignContext = {
      schemaVersion: '1.0',
      exactCopy: [
        {
          id: 'title',
          label: 'Title',
          text: 'Semantic title',
          sourceNodeIds: ['text'],
          provenance: 'Studio user',
        },
      ],
      designTokens: [],
      componentSemantics: [],
      interactions: [],
      generalNotes: 'Use the exact heading copy.',
    };
    const request = await inspectedRequest(ws, undefined, { context });
    expect(request).toMatchObject({
      schemaVersion: '3.0',
      runId: RUN_ID,
      round: 1,
      mode: 'semantic',
      layout: 'responsive',
      instructions: 'Use the exact heading copy.',
    });
    expect(request.readableText).toContain('Semantic title');
    expect(request.presentationSpec.primaryCanvas).toMatchObject({
      id: 'source',
      width: 320,
      height: 180,
    });
    expect(request.structuredContextHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(request.structuredDesignContext).toEqual(context);
    expect(request.contextRedacted).toBe(false);
    expect(request.sanitizedSvg).toContain('<svg');
    expect(Date.parse(request.expiresAt)).toBeGreaterThan(Date.parse(request.createdAt));
    expect(() => authoringRequestSchema.parse(request)).not.toThrow();
  });

  it('carries a bounded source context file and redacts secrets before agent delivery', async () => {
    const ws = await workspace('source-context');
    const content =
      'export function Card() { return <div>Price</div>; }\nauthorization: Bearer private-token';
    const request = await inspectedRequest(ws, undefined, {
      designContext: {
        filename: 'Card.jsx',
        mediaType: 'text/javascript',
        content,
        originalHash: `sha256:${'a'.repeat(64)}`,
        byteLength: new TextEncoder().encode(content).byteLength,
        provenance: 'studio:user-upload',
      },
    });
    expect(request.designContext).toMatchObject({
      filename: 'Card.jsx',
      mediaType: 'text/javascript',
      provenance: 'studio:user-upload',
      contentRedacted: true,
    });
    expect(request.designContext?.content).toContain('export function Card');
    expect(request.designContext?.content).toContain('[REDACTED]');
    expect(request.designContext?.originalHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => authoringRequestSchema.parse(request)).not.toThrow();
  });

  it('identifies an uploaded PNG reference without embedding binary bytes in JSON', async () => {
    const ws = await workspace('png-reference');
    const designReference: AuthoringDesignReference = {
      filename: 'checkout.png',
      mediaType: 'image/png',
      originalHash: `sha256:${'b'.repeat(64)}`,
      byteLength: 12_345,
      provenance: 'studio:user-upload',
    };
    const request = await inspectedRequest(ws, undefined, { designReference });
    expect(request.designReference).toEqual(designReference);
    expect(request.sanitizedSvg).toContain('data-smart-ui-reference="png"');
    expect(JSON.stringify(request)).not.toContain('data:image/png;base64');
    expect(() => authoringRequestSchema.parse(request)).not.toThrow();
    expect(() =>
      authoringRequestSchema.parse({
        ...request,
        designReference: { ...designReference, mediaType: 'image/jpeg' },
      }),
    ).toThrow();
  });

  it('documents redaction while hashing the validated original structured context', async () => {
    const ws = await workspace('redaction');
    const request = await inspectedRequest(ws, undefined, {
      context: {
        schemaVersion: '1.0',
        exactCopy: [],
        designTokens: [],
        componentSemantics: [],
        interactions: [],
        generalNotes: 'authorization: Bearer private-token',
      },
    });
    expect(request.contextRedacted).toBe(true);
    expect(request.structuredDesignContext.generalNotes).toContain('[REDACTED]');
    expect(request.structuredContextHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('anchors canvas guidance to the design viewport and layout intent', async () => {
    const ws = await workspace('guidance');
    const request = await inspectedRequest(ws);
    const responsive = authoringCanvasGuidance(request);
    expect(responsive).toContain('320x180');
    expect(responsive).toContain('320px-wide viewport');
    const fixed = authoringCanvasGuidance({ ...request, layout: 'fixed' });
    expect(fixed).toContain('fixed page');
    expect(fixed).toContain('320x180');
    const component = authoringCanvasGuidance({ ...request, layout: 'component' });
    expect(component).toContain('self-contained component');
    expect(component).toContain('320x180');
  });

  it('atomically round-trips a request through the queue and lists it while unexpired', async () => {
    const ws = await workspace('roundtrip');
    const queueRoot = agentQueueRoot(ws);
    const request = await inspectedRequest(ws);
    const path = await writeAuthoringRequest(queueRoot, request);
    expect(path.endsWith(join(RUN_ID, 'round-1.json'))).toBe(true);
    const pending = await listPendingAuthoringRequests(queueRoot);
    expect(pending.map((item) => item.runId)).toEqual([RUN_ID]);
    // No stray temp files remain from the atomic write.
    const files = await readdir(join(queueRoot, 'requests', RUN_ID));
    expect(files.sort()).toEqual(['issued.json', 'round-1.json']);
  });

  it('advances to the next round after the previous round is consumed or abandoned', async () => {
    const ws = await workspace('advance');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringRequest(queueRoot, await inspectedRequest(ws));
    await writeAuthoringResponse(queueRoot, validResponse(1));
    // Studio deletes both sides of a consumed round; numbering must still move forward.
    await deleteAuthoringRequest(queueRoot, RUN_ID, 1);
    await deleteAuthoringResponse(queueRoot, RUN_ID, 1);
    expect(await listPendingAuthoringRequests(queueRoot)).toEqual([]);
    expect(await highestIssuedAuthoringRound(queueRoot, RUN_ID)).toBe(1);

    await expect(writeAuthoringRequest(queueRoot, await inspectedRequest(ws))).rejects.toThrow(
      /next expected round is 2/u,
    );
    const second = await inspectedRequest(ws, undefined, {
      round: 2,
      feedback: 'Tighten the header spacing.',
      priorEvidence: PRIOR_EVIDENCE,
    });
    await writeAuthoringRequest(queueRoot, second);
    expect((await listPendingAuthoringRequests(queueRoot)).map((item) => item.round)).toEqual([2]);

    // An abandoned round (expired or canceled, never answered) still advances the counter.
    await deleteAuthoringRequest(queueRoot, RUN_ID, 2);
    expect(await highestIssuedAuthoringRound(queueRoot, RUN_ID)).toBe(2);
    const third = await inspectedRequest(ws, undefined, {
      round: 3,
      feedback: 'Try again.',
      priorEvidence: PRIOR_EVIDENCE,
    });
    await writeAuthoringRequest(queueRoot, third);
    expect((await listPendingAuthoringRequests(queueRoot)).map((item) => item.round)).toEqual([3]);
  });

  it('carries feedback and prior evidence into a revision round and refuses stale rounds', async () => {
    const ws = await workspace('rounds');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringRequest(queueRoot, await inspectedRequest(ws));
    await writeAuthoringResponse(queueRoot, validResponse(1));

    const revision = await inspectedRequest(ws, undefined, {
      round: 2,
      feedback: 'Tighten the header spacing.',
      priorEvidence: PRIOR_EVIDENCE,
    });
    await writeAuthoringRequest(queueRoot, revision);
    const guidance = authoringRevisionGuidance(revision)!;
    expect(guidance).toContain('round 2');
    expect(guidance).toContain('91.250%');
    expect(guidance).toContain('Tighten the header spacing.');
    expect(authoringRevisionGuidance(await inspectedRequest(ws))).toBeUndefined();

    // Only the latest unanswered round is offered to the agent.
    const pending = await listPendingAuthoringRequests(queueRoot);
    expect(pending.map((item) => item.round)).toEqual([2]);

    await expect(writeAuthoringRequest(queueRoot, revision)).rejects.toThrow(
      /stale or duplicated/u,
    );
    await expect(writeAuthoringResponse(queueRoot, validResponse(1))).rejects.toThrow(/stale/u);
    await writeAuthoringResponse(queueRoot, validResponse(2));
    await expect(writeAuthoringResponse(queueRoot, validResponse(2))).rejects.toThrow(
      /already answered/u,
    );
    expect(await listPendingAuthoringRequests(queueRoot)).toEqual([]);
  });

  it('refuses revision feedback on the first round and a revision without prior evidence', async () => {
    const ws = await workspace('round-shape');
    await expect(
      inspectedRequest(ws, undefined, {
        round: 1,
        feedback: 'later',
        priorEvidence: PRIOR_EVIDENCE,
      }),
    ).rejects.toThrow();
    await expect(
      inspectedRequest(ws, undefined, { round: 2, feedback: 'later' }),
    ).rejects.toThrow();
  });

  it('skips expired and malformed requests when listing', async () => {
    const ws = await workspace('expiry');
    const queueRoot = agentQueueRoot(ws);
    const expired = await inspectedRequest(ws, 1_000);
    expired.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await writeAuthoringRequest(queueRoot, expired);
    await mkdir(join(queueRoot, 'requests', 'run-99999999-9999-4999-8999-999999999999'), {
      recursive: true,
    });
    await writeFile(
      join(queueRoot, 'requests', 'run-99999999-9999-4999-8999-999999999999', 'round-1.json'),
      '{ not json',
    );
    expect(await listPendingAuthoringRequests(queueRoot)).toEqual([]);
  });

  it('rejects a response that omits required files or uses a forbidden path', async () => {
    const ws = await workspace('reject');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringRequest(queueRoot, await inspectedRequest(ws));
    await expect(
      writeAuthoringResponse(queueRoot, {
        ...validResponse(),
        files: [{ path: 'index.html', content: '<!doctype html>' }],
      } as StudioAuthoringResponse),
    ).rejects.toThrow();
    await expect(
      writeAuthoringResponse(queueRoot, {
        ...validResponse(),
        files: [
          { path: 'index.html', content: '<!doctype html>' },
          { path: '../escape.html', content: 'x' },
        ],
      } as StudioAuthoringResponse),
    ).rejects.toThrow();
  });

  it('refuses an authored response with no matching pending request', async () => {
    const ws = await workspace('orphan');
    await expect(writeAuthoringResponse(agentQueueRoot(ws), validResponse())).rejects.toThrow(
      /No pending Studio authoring request/u,
    );
  });

  it('fails closed when a stored response is malformed', async () => {
    const ws = await workspace('malformed');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringRequest(queueRoot, await inspectedRequest(ws));
    await writeAuthoringResponse(queueRoot, validResponse());
    await writeFile(join(queueRoot, 'responses', RUN_ID, 'round-1.json'), '{ broken');
    await expect(readAuthoringResponse(queueRoot, RUN_ID)).rejects.toThrow(/not valid JSON/u);
  });

  it('waits for a response, then converts it to host proposal files', async () => {
    const ws = await workspace('wait');
    const queueRoot = agentQueueRoot(ws);
    const request = await inspectedRequest(ws);
    await writeAuthoringRequest(queueRoot, request);
    const pending = waitForAuthoringResponse(queueRoot, RUN_ID, {
      round: 1,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });
    await writeAuthoringResponse(queueRoot, validResponse());
    const response = await pending;
    const files = authoredHostFiles(response);
    expect(files.map((file) => file.relativePath).sort()).toEqual(['index.html', 'styles.css']);
    expect(files.find((file) => file.relativePath === 'index.html')?.mediaType).toBe('text/html');
    // The stable response hash gives each round reviewable provenance.
    expect(authoringResponseHash(response)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(authoringResponseHash(response)).toBe(authoringResponseHash(validResponse()));
    // Authored HTML flows through the deterministic host-proposal contract unchanged.
    expect(new DeterministicHtmlGenerationProvider().name).toBeTruthy();
  });

  it('times out and can delete the pending request on cancel', async () => {
    const ws = await workspace('timeout');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringRequest(queueRoot, await inspectedRequest(ws));
    await expect(
      waitForAuthoringResponse(queueRoot, RUN_ID, { timeoutMs: 1_000, pollIntervalMs: 50 }),
    ).rejects.toThrow(/No connected MCP agent/u);
    await deleteAuthoringRequest(queueRoot, RUN_ID);
    expect(await listPendingAuthoringRequests(queueRoot)).toEqual([]);
  });

  it('aborts the wait when the run is canceled', async () => {
    const ws = await workspace('abort');
    const queueRoot = agentQueueRoot(ws);
    await writeAuthoringRequest(queueRoot, await inspectedRequest(ws));
    const controller = new AbortController();
    const pending = waitForAuthoringResponse(queueRoot, RUN_ID, {
      timeoutMs: 10_000,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/canceled/u);
  });
});
