import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_AUTHORING_TIMEOUT_MS,
  DeterministicHtmlGenerationProvider,
  GenerationOrchestrator,
  HostProposedHtmlGenerationProvider,
  HtmlGenerationReporter,
  LocalArtifactStore,
  LocalSvgStructureProvider,
  LoopbackGeneratedPreviewProvider,
  MAX_AUTHORING_ROUNDS,
  PlaywrightBrowserProvider,
  ReproducibleGenerationExporter,
  SmartUiError,
  agentQueueRoot,
  authoredHostFiles,
  authoringResponseHash,
  buildAuthoringRequest,
  deleteAuthoringRequest,
  deleteAuthoringResponse,
  generationRecordSchema,
  highestIssuedAuthoringRound,
  loadConfig,
  svgGenerationInputSchema,
  waitForAuthoringResponse,
  writeAuthoringRequest,
  type ArtifactRef,
  type AuthoringPriorEvidence,
  type AuthoringVisualEvidence,
  type GeneratedPreviewSession,
  type GenerationLayout,
  type GenerationMode,
  type GenerationRecord,
  type HtmlGenerationProvider,
  type SvgInspectionResult,
} from 'smart-ui-validator-core';

const MARKER_NAME = '.smart-ui-studio.json';
const RUNS_NAME = 'runs';
const POINTER_NAME = 'studio-run.json';
const COOKIE_NAME = 'smart_ui_studio';
const RUN_ID = /^run-[a-f0-9-]{36}$/u;
const RECORD_PATH = /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/u;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_IMPROVE_ROUNDS = 5;
const MAX_JSON_BYTES = 16_384;

const STUDIO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  'frame-src http://127.0.0.1:*',
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface StudioServerOptions {
  workspaceRoot: string;
  staticRoot?: string;
  port?: number;
  retentionMs?: number;
  /** How long a run waits for the connected MCP agent to author HTML before failing closed. */
  agentTimeoutMs?: number;
  /** Bound on confirm-then-improve revision rounds beyond the first authored round. */
  maxImproveRounds?: number;
}

export interface StudioServer {
  readonly url: string;
  readonly workspaceRoot: string;
  health(): Promise<StudioHealth>;
  close(): Promise<void>;
}

export interface StudioHealth {
  status: 'ready' | 'degraded';
  checks: {
    engine: boolean;
    browserAdapter: boolean;
    studioAssets: boolean;
    loopback: boolean;
    writable: boolean;
    workspaceContained: boolean;
  };
}

interface InspectionSummary {
  filename: string;
  width: number;
  height: number;
  readableTextNodes: number;
  originalInputHash: string;
  sanitizedHash: string;
  sanitization: GenerationRecord['sanitization'];
  uncertaintyCount: number;
  recommendedModes: GenerationMode[];
}

type RunPhase =
  | 'inspected'
  | 'generating'
  | 'awaiting-agent'
  | 'awaiting-agent-revision'
  | 'awaiting-decision'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted';

interface RunPreferences {
  engine: 'agent' | 'deterministic';
  mode: GenerationMode;
  layout: GenerationLayout;
  instructions?: string;
  improve: boolean;
}

/** Immutable evidence for one authored round of a run. */
interface RunRound {
  round: number;
  createdAt: string;
  engine: 'agent' | 'deterministic';
  authoringAgent?: string;
  feedback?: string;
  feedbackHash?: string;
  responseHash?: string;
  recordArtifactPath: string;
  visualSimilarity: number | null;
  visualMismatchPercent: number | null;
  accepted: boolean;
}

interface StudioRun {
  id: string;
  root: string;
  artifactRoot: string;
  uploadPath: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  phase: RunPhase;
  progress: { stage: string; value: number; message: string };
  inspection?: InspectionSummary;
  preferences?: RunPreferences;
  rounds: RunRound[];
  records: Map<number, GenerationRecord>;
  selectedRound?: number;
  acceptedRound?: number;
  pending?: { round: number; feedback?: string };
  record?: GenerationRecord;
  recordArtifactPath?: string;
  error?: { code: string; message: string; recovery: string };
  controller: AbortController | undefined;
  task: Promise<void> | undefined;
  preview?: GeneratedPreviewSession;
}

interface PersistedRun {
  schemaVersion: '1.0';
  runId: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  phase: RunPhase;
  progress: StudioRun['progress'];
  inspection?: InspectionSummary;
  preferences?: RunPreferences;
  rounds?: RunRound[];
  selectedRound?: number;
  acceptedRound?: number;
  recordArtifactPath?: string;
  error?: StudioRun['error'];
}

interface StaticAsset {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

const RUN_PHASES: RunPhase[] = [
  'inspected',
  'generating',
  'awaiting-agent',
  'awaiting-agent-revision',
  'awaiting-decision',
  'completed',
  'failed',
  'canceled',
  'interrupted',
];

/** Phases owned by a live in-process task; they cannot survive a restart. */
function isActivePhase(phase: RunPhase): boolean {
  return (
    phase === 'generating' || phase === 'awaiting-agent' || phase === 'awaiting-agent-revision'
  );
}

export async function initializeStudioWorkspace(workspaceRoot: string): Promise<{
  workspaceRoot: string;
  workspaceId: string;
  initialized: boolean;
}> {
  const workspace = assertBroadRootSafe(workspaceRoot);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await assertDirectoryNotLink(workspace, 'Studio workspace');
  const markerPath = join(workspace, MARKER_NAME);
  try {
    const marker = parseMarker(JSON.parse(await readFile(markerPath, 'utf8')));
    await mkdir(join(workspace, RUNS_NAME), { recursive: true, mode: 0o700 });
    return { workspaceRoot: workspace, workspaceId: marker.workspaceId, initialized: false };
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const entries = await readdir(workspace);
  if (entries.length > 0) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      'Studio initialization requires a new empty dedicated workspace.',
    );
  }
  const marker = {
    schemaVersion: '1.0' as const,
    workspaceId: randomUUID(),
    createdAt: new Date().toISOString(),
    plaintextStorage: true,
  };
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await mkdir(join(workspace, RUNS_NAME), { recursive: false, mode: 0o700 });
  return { workspaceRoot: workspace, workspaceId: marker.workspaceId, initialized: true };
}

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const workspace = await requireStudioWorkspace(options.workspaceRoot);
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const staticRoot = resolve(
    options.staticRoot ??
      (moduleRoot.endsWith(`${join('apps', 'studio', 'src')}`)
        ? join(moduleRoot, '..', 'dist', 'public')
        : join(moduleRoot, 'public')),
  );
  const assets = await loadStaticAssets(staticRoot);
  const retentionMs = boundedRetention(options.retentionMs ?? DEFAULT_RETENTION_MS);
  const agentTimeoutMs = boundedAgentTimeout(options.agentTimeoutMs);
  const maxImproveRounds = boundedImproveRounds(options.maxImproveRounds);
  const queueRoot = agentQueueRoot(workspace);
  const capability = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const runs = new Map<string, StudioRun>();
  const runsRoot = join(workspace, RUNS_NAME);
  let expectedHost = '';
  let origin = '';
  let closed = false;

  await recoverRuns(workspace, runs, retentionMs);

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const failure = publicFailure(error, workspace);
      json(response, failure.status, {
        error: failure.code,
        message: failure.message,
        recovery: failure.recovery,
      });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response);
    if (request.headers.host !== expectedHost) {
      drain(request);
      text(response, 421, 'Misdirected request');
      return;
    }
    const url = parseRequestUrl(request.url);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if (pathname === '/index.html') {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return method(response, 'GET, HEAD');
      response.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${capability}; Path=/; HttpOnly; SameSite=Strict`,
      );
      return serveAsset(response, request.method, assets.get('/index.html'));
    }
    if (pathname.startsWith('/assets/')) {
      requireSession(request, capability);
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return method(response, 'GET, HEAD');
      return serveAsset(response, request.method, assets.get(pathname));
    }
    if (!pathname.startsWith('/api/')) {
      drain(request);
      return text(response, 404, 'Not found');
    }

    requireSession(request, capability);
    if (pathname === '/api/session') {
      if (request.method !== 'GET') return method(response, 'GET');
      requireSameSiteFetch(request);
      return json(response, 200, {
        csrfToken: csrf,
        runs: [...runs.values()].map((item) => runSummary(item, maxImproveRounds)),
        limits: { maxUploadBytes: (await loadConfig(workspace)).generation.limits.maxSvgBytes },
        agent: { configured: true, transport: 'mcp', workspace, maxImproveRounds },
      });
    }
    const readOnlyArtifactRequest =
      (request.method === 'GET' || request.method === 'HEAD') &&
      /^\/api\/runs\/run-[a-f0-9-]{36}\/(?:download|evidence)\//u.test(pathname);
    if (readOnlyArtifactRequest) requireSameSiteFetch(request);
    else requireApiRequest(request, origin, csrf);
    if (pathname === '/api/health') {
      if (request.method !== 'GET') return method(response, 'GET');
      return json(response, 200, await health());
    }
    if (pathname === '/api/runs') {
      if (request.method === 'GET')
        return json(
          response,
          200,
          [...runs.values()].map((item) => runSummary(item, maxImproveRounds)),
        );
      if (request.method !== 'POST') return method(response, 'GET, POST');
      exactContentType(request, 'image/svg+xml');
      const filename = uploadFilename(request.headers['x-smart-ui-filename']);
      const run = await inspectUpload(request, workspace, filename);
      runs.set(run.id, run);
      await persistRun(run);
      return json(response, 201, runSummary(run, maxImproveRounds));
    }

    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] !== 'api' || segments[1] !== 'runs' || !RUN_ID.test(segments[2] ?? '')) {
      drain(request);
      return text(response, 404, 'Not found');
    }
    const run = runs.get(segments[2]!);
    if (!run) {
      drain(request);
      throw new SmartUiError('NOT_FOUND', 'Studio run was not found.');
    }
    if (segments.length === 3) {
      if (request.method === 'GET') return json(response, 200, runSummary(run, maxImproveRounds));
      if (request.method === 'DELETE') {
        await deleteRun(run, runsRoot);
        runs.delete(run.id);
        return json(response, 200, { runId: run.id, deleted: true, verified: true });
      }
      return method(response, 'GET, DELETE');
    }
    if (segments[3] === 'generate' && segments.length === 4) {
      if (request.method !== 'POST') return method(response, 'POST');
      exactContentType(request, 'application/json');
      if (run.phase !== 'inspected') {
        throw new SmartUiError('POLICY_VIOLATION', 'Only an inspected run can start generation.');
      }
      const preferences = parsePreferences(await readJsonBody(request));
      const firstRound = await nextAuthoringRound(run);
      run.preferences = preferences;
      run.phase = 'generating';
      run.updatedAt = new Date().toISOString();
      run.progress = { stage: 'generate', value: 0.15, message: 'Generation queued.' };
      run.controller = new AbortController();
      await persistRun(run);
      run.task = startRound(run, firstRound).finally(() => {
        run.task = undefined;
        run.controller = undefined;
      });
      return json(response, 202, runSummary(run, maxImproveRounds));
    }
    if (segments[3] === 'decision' && segments.length === 4) {
      if (request.method !== 'POST') return method(response, 'POST');
      exactContentType(request, 'application/json');
      const decision = parseDecision(await readJsonBody(request));
      if (run.phase !== 'awaiting-decision') {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          'Only a run awaiting your decision can be accepted or improved.',
        );
      }
      if (decision.action === 'accept') {
        await acceptRound(run, decision.round);
        return json(response, 200, runSummary(run, maxImproveRounds));
      }
      if (run.rounds.length > maxImproveRounds) {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          `This run reached its bound of ${maxImproveRounds} improvement rounds; accept the round you prefer.`,
        );
      }
      const nextRound = await nextAuthoringRound(run);
      delete run.error;
      run.phase = 'generating';
      run.progress = {
        stage: 'generate',
        value: 0.15,
        message: `Improvement round ${nextRound} queued.`,
      };
      run.updatedAt = new Date().toISOString();
      run.controller = new AbortController();
      await persistRun(run);
      run.task = startRound(run, nextRound, decision.feedback).finally(() => {
        run.task = undefined;
        run.controller = undefined;
      });
      return json(response, 202, runSummary(run, maxImproveRounds));
    }
    if (segments[3] === 'cancel' && segments.length === 4) {
      if (request.method !== 'POST') return method(response, 'POST');
      exactContentType(request, 'application/json');
      await readJsonBody(request);
      if (isActivePhase(run.phase)) run.controller?.abort();
      return json(response, 202, { runId: run.id, cancellationRequested: true });
    }
    if (segments[3] === 'files' && segments.length === 5) {
      if (request.method !== 'GET') return method(response, 'GET');
      const file = generatedFile(run, segments[4]);
      const bytes = await new LocalArtifactStore(run.artifactRoot).read(file.artifact.relativePath);
      if (!isTextMediaType(file.mediaType)) {
        throw new SmartUiError(
          'POLICY_VIOLATION',
          'Only generated text files are shown as source.',
        );
      }
      return json(response, 200, {
        relativePath: file.relativePath,
        mediaType: file.mediaType,
        source: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      });
    }
    if (segments[3] === 'download') {
      if (request.method !== 'GET') return method(response, 'GET');
      return download(run, segments.slice(4), response, request.method);
    }
    if (segments[3] === 'evidence' && segments.length === 5) {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return method(response, 'GET, HEAD');
      return evidence(run, segments[4]!, response, request.method);
    }
    drain(request);
    text(response, 404, 'Not found');
  }

  async function inspectUpload(
    request: IncomingMessage,
    root: string,
    filename: string,
  ): Promise<StudioRun> {
    const config = await loadConfig(root);
    const id = `run-${randomUUID()}`;
    const runRoot = join(runsRoot, id);
    const inputRoot = join(runRoot, 'input');
    const uploadPath = join(inputRoot, 'upload.svg');
    const inspectionArtifactRoot = join(runRoot, 'inspection-artifacts');
    await mkdir(inputRoot, { recursive: true, mode: 0o700 });
    try {
      await streamUpload(request, uploadPath, config.generation.limits.maxSvgBytes);
      const store = new LocalArtifactStore(inspectionArtifactRoot);
      const inspection = await new LocalSvgStructureProvider(
        store,
        config.generation.limits,
      ).inspect(
        svgGenerationInputSchema.parse({
          workspaceRoot: root,
          svgPath: uploadPath,
          artifactRoot: inspectionArtifactRoot,
          mode: 'hybrid',
          layout: 'responsive',
          rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
        }),
      );
      const readableTextNodes = inspection.bundle.scene.nodes.filter(
        (node) => node.type === 'text' && Boolean(node.text?.trim()),
      ).length;
      const now = new Date().toISOString();
      return {
        id,
        root: runRoot,
        artifactRoot: roundArtifactRoot(runRoot, 1),
        uploadPath,
        filename,
        createdAt: now,
        updatedAt: now,
        phase: 'inspected',
        progress: { stage: 'inspect', value: 0.12, message: 'SVG accepted and inspected.' },
        rounds: [],
        records: new Map(),
        controller: undefined,
        task: undefined,
        inspection: {
          filename,
          width: inspection.bundle.viewport.width,
          height: inspection.bundle.viewport.height,
          readableTextNodes,
          originalInputHash: inspection.bundle.originalInputHash,
          sanitizedHash: inspection.bundle.sanitizedHash,
          sanitization: inspection.bundle.sanitization,
          uncertaintyCount: inspection.bundle.uncertainties.length,
          recommendedModes: readableTextNodes > 0 ? ['hybrid', 'semantic', 'exact'] : ['exact'],
        },
      };
    } catch (error) {
      await rm(runRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async function startRound(run: StudioRun, round: number, feedback?: string): Promise<void> {
    const preferences = run.preferences;
    if (!preferences)
      throw new SmartUiError('INVALID_INPUT', 'Generation preferences are missing.');
    let authoring: { authoringAgent: string; responseHash: string } | undefined;
    try {
      const config = await loadConfig(workspace);
      const artifactRoot = roundArtifactRoot(run.root, round);
      const store = new LocalArtifactStore(artifactRoot);
      const generationInput = svgGenerationInputSchema.parse({
        workspaceRoot: workspace,
        svgPath: run.uploadPath,
        artifactRoot,
        generationId: `generation-${randomUUID()}`,
        mode: preferences.mode,
        layout: preferences.layout,
        ...(preferences.instructions ? { instructions: preferences.instructions } : {}),
        rendering: { background: { kind: 'transparent' }, locale: 'en-US', theme: 'light' },
      });
      const structure = new LocalSvgStructureProvider(store, config.generation.limits);
      let generator: HtmlGenerationProvider = new DeterministicHtmlGenerationProvider();
      let fallbackGenerator: HtmlGenerationProvider | undefined;
      let proposalPolicy: 'non-regression' | 'prefer-proposal' | undefined;
      if (preferences.engine === 'agent') {
        const authored = await authorWithConnectedAgent(
          run,
          generationInput,
          config,
          round,
          feedback,
        );
        generator = new HostProposedHtmlGenerationProvider(
          `studio-agent:${authored.authoringAgent}`,
          authored.files,
        );
        fallbackGenerator = new DeterministicHtmlGenerationProvider();
        proposalPolicy = 'prefer-proposal';
        authoring = {
          authoringAgent: authored.authoringAgent,
          responseHash: authored.responseHash,
        };
      }
      const result = await new GenerationOrchestrator({
        structure,
        generator,
        ...(fallbackGenerator ? { fallbackGenerator } : {}),
        ...(proposalPolicy ? { proposalPolicy } : {}),
        preview: new LoopbackGeneratedPreviewProvider(),
        browser: new PlaywrightBrowserProvider(),
        artifacts: store,
        reporter: new HtmlGenerationReporter(store),
        exporter: new ReproducibleGenerationExporter(workspace),
        config,
        tool: 'smart-ui-studio',
        onProgress: async (event) => {
          run.progress = { stage: event.stage, value: event.progress, message: event.message };
          run.updatedAt = new Date().toISOString();
        },
      }).run(generationInput, run.controller?.signal);
      selectRecord(run, result.record, result.recordArtifact.relativePath, artifactRoot);
      const acceptedPass = [...result.record.passes].reverse().find((pass) => pass.accepted);
      run.rounds.push({
        round,
        createdAt: new Date().toISOString(),
        engine: preferences.engine,
        ...(authoring ? { authoringAgent: authoring.authoringAgent } : {}),
        ...(feedback ? { feedback, feedbackHash: textHash(feedback) } : {}),
        ...(authoring ? { responseHash: authoring.responseHash } : {}),
        recordArtifactPath: result.recordArtifact.relativePath,
        visualSimilarity: acceptedPass ? Math.max(0, 100 - acceptedPass.diffPercent) : null,
        visualMismatchPercent: acceptedPass?.diffPercent ?? null,
        accepted: false,
      });
      run.selectedRound = round;
      run.records.set(round, result.record);
      run.phase = result.record.canceled
        ? 'canceled'
        : result.record.status === 'failed'
          ? 'failed'
          : preferences.improve && preferences.engine === 'agent'
            ? 'awaiting-decision'
            : 'completed';
      if (run.phase === 'completed') markAccepted(run, round);
      run.progress = {
        stage: run.phase,
        value: 1,
        message:
          run.phase === 'completed'
            ? 'Generation completed.'
            : run.phase === 'awaiting-decision'
              ? `Round ${round} is ready. Accept it, or describe what to improve.`
              : run.phase === 'canceled'
                ? 'Generation canceled.'
                : 'Generation failed.',
      };
      if (run.record && run.record.generatedFiles.length > 0) await startRunPreview(run);
    } catch (error) {
      const failure = publicFailure(error, workspace);
      const canceled = run.controller?.signal.aborted ?? false;
      // A failed revision keeps every earlier round available for acceptance.
      run.phase = run.rounds.length > 0 ? 'awaiting-decision' : canceled ? 'canceled' : 'failed';
      run.error = {
        code: failure.code,
        message: failure.message,
        recovery: failure.recovery,
      };
      run.progress = { stage: run.phase, value: 1, message: failure.message };
    } finally {
      delete run.pending;
      run.updatedAt = new Date().toISOString();
      await persistRun(run);
    }
  }

  async function acceptRound(run: StudioRun, round: number | undefined): Promise<void> {
    const target =
      round === undefined ? run.rounds.at(-1) : run.rounds.find((item) => item.round === round);
    if (!target) throw new SmartUiError('NOT_FOUND', 'That authoring round was not found.');
    const record = run.records.get(target.round);
    if (!record) {
      throw new SmartUiError('NOT_FOUND', 'The evidence for that authoring round is unavailable.');
    }
    selectRecord(run, record, target.recordArtifactPath, roundArtifactRoot(run.root, target.round));
    run.selectedRound = target.round;
    markAccepted(run, target.round);
    run.phase = 'completed';
    delete run.error;
    run.progress = {
      stage: 'completed',
      value: 1,
      message: `Accepted authoring round ${target.round}.`,
    };
    run.updatedAt = new Date().toISOString();
    if (record.generatedFiles.length > 0) await startRunPreview(run);
    await persistRun(run);
  }

  async function authorWithConnectedAgent(
    run: StudioRun,
    generationInput: ReturnType<typeof svgGenerationInputSchema.parse>,
    config: Awaited<ReturnType<typeof loadConfig>>,
    round: number,
    feedback: string | undefined,
  ): Promise<{
    files: ReturnType<typeof authoredHostFiles>;
    authoringAgent: string;
    responseHash: string;
  }> {
    const signal = run.controller?.signal;
    const inspectionArtifactRoot = join(run.root, 'agent-inspection-artifacts');
    const inspectionStore = new LocalArtifactStore(inspectionArtifactRoot);
    const inspectionInput = svgGenerationInputSchema.parse({
      ...generationInput,
      artifactRoot: inspectionArtifactRoot,
    });
    const inspection = await new LocalSvgStructureProvider(
      inspectionStore,
      config.generation.limits,
    ).inspect(inspectionInput, signal);
    const previous = run.rounds.at(-1);
    const visualEvidence = [
      ...(await designRenderEvidence(
        run,
        inspectionInput,
        inspection,
        config,
        inspectionArtifactRoot,
      )),
      ...(previous ? priorVisualEvidence(run, previous) : []),
    ];
    const request = buildAuthoringRequest({
      runId: run.id,
      input: generationInput,
      inspection,
      round,
      ...(feedback ? { feedback } : {}),
      ...(previous ? { priorEvidence: priorEvidence(run, previous) } : {}),
      ...(previous?.responseHash ? { previousResponseHash: previous.responseHash } : {}),
      ...(visualEvidence.length > 0 ? { visualEvidence } : {}),
      timeoutMs: agentTimeoutMs,
    });
    await writeAuthoringRequest(queueRoot, request);
    run.phase = round === 1 ? 'awaiting-agent' : 'awaiting-agent-revision';
    run.pending = { round, ...(feedback ? { feedback } : {}) };
    run.progress = {
      stage: 'agent',
      value: 0.2,
      message:
        round === 1
          ? 'Waiting for the connected MCP agent to author HTML. In chat, ask it to check Smart UI Studio authoring requests.'
          : `Waiting for the connected MCP agent to author improvement round ${round}.`,
    };
    run.updatedAt = new Date().toISOString();
    await persistRun(run);
    try {
      const response = await waitForAuthoringResponse(queueRoot, run.id, {
        round,
        timeoutMs: agentTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      run.phase = 'generating';
      run.progress = {
        stage: 'generate',
        value: 0.25,
        message: `Validating and measuring HTML authored by ${response.authoringAgent}.`,
      };
      run.updatedAt = new Date().toISOString();
      return {
        files: authoredHostFiles(response),
        authoringAgent: response.authoringAgent,
        responseHash: authoringResponseHash(response),
      };
    } finally {
      await deleteAuthoringRequest(queueRoot, run.id, round);
      await deleteAuthoringResponse(queueRoot, run.id, round);
    }
  }

  /**
   * Renders the sanitized design once, in isolation, so the authoring agent can look at the design
   * instead of only parsing SVG paths. Optional evidence: a render failure must not fail the round.
   */
  async function designRenderEvidence(
    run: StudioRun,
    input: ReturnType<typeof svgGenerationInputSchema.parse>,
    inspection: SvgInspectionResult,
    config: Awaited<ReturnType<typeof loadConfig>>,
    artifactRoot: string,
  ): Promise<AuthoringVisualEvidence[]> {
    const signal = run.controller?.signal;
    try {
      const exact = await new DeterministicHtmlGenerationProvider().generate(
        { ...input, mode: 'exact' },
        inspection,
        signal,
      );
      const session = await new LoopbackGeneratedPreviewProvider().serve(exact, signal);
      let screenshot: Uint8Array;
      try {
        screenshot = (
          await new PlaywrightBrowserProvider().capture({
            url: session.url,
            viewport: inspection.bundle.viewport,
            timeoutMs: Math.min(config.generation.timeoutMs, 60_000),
            locale: input.rendering.locale,
            theme: input.rendering.theme,
            allowedEndpoints: [session.origin],
            blockExternalNetwork: true,
            screenshotBeforeFocusProbe: true,
            evidenceLimits: config.evidence,
            ...(signal ? { signal } : {}),
          })
        ).screenshot;
      } finally {
        await session.close();
      }
      const artifact = await new LocalArtifactStore(artifactRoot).put(
        screenshot,
        'image/png',
        'design-render.png',
      );
      return [
        {
          kind: 'design-render',
          label: `Rendered reference of the design at ${inspection.bundle.viewport.width}x${inspection.bundle.viewport.height}`,
          mediaType: 'image/png',
          workspaceRelativePath: workspaceRelativeArtifact(
            workspace,
            artifactRoot,
            artifact.relativePath,
          ),
          hash: artifact.hash,
          byteLength: artifact.byteLength,
        },
      ];
    } catch {
      return [];
    }
  }

  /** Measured images from the previous round so a revision can see what it is correcting. */
  function priorVisualEvidence(run: StudioRun, previous: RunRound): AuthoringVisualEvidence[] {
    const record = run.records.get(previous.round);
    const pass = record ? [...record.passes].reverse().find((item) => item.accepted) : undefined;
    if (!pass) return [];
    const entries: Array<[AuthoringVisualEvidence['kind'], string, ArtifactRef]> = [
      ['previous-render', `Round ${previous.round} rendered output`, pass.screenshot],
      ['previous-diff', `Round ${previous.round} pixel difference against the design`, pass.diff],
      ['previous-overlay', `Round ${previous.round} overlay on the design`, pass.overlay],
    ];
    return entries
      .filter(([, , artifact]) => artifact.mediaType === 'image/png')
      .map(([kind, label, artifact]) => ({
        kind,
        label,
        mediaType: 'image/png' as const,
        workspaceRelativePath: workspaceRelativeArtifact(
          workspace,
          roundArtifactRoot(run.root, previous.round),
          artifact.relativePath,
        ),
        hash: artifact.hash,
        byteLength: artifact.byteLength,
        round: previous.round,
      }));
  }

  /** Next authoring round for a run, monotonic across completed, failed, and abandoned rounds. */
  async function nextAuthoringRound(run: StudioRun): Promise<number> {
    const completed = run.rounds.at(-1)?.round ?? 0;
    const issued = await highestIssuedAuthoringRound(queueRoot, run.id);
    const next = Math.max(completed, issued) + 1;
    if (next > MAX_AUTHORING_ROUNDS) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        `This run reached the hard bound of ${MAX_AUTHORING_ROUNDS} authoring rounds; accept the round you prefer or start a new run.`,
      );
    }
    return next;
  }

  async function health(): Promise<StudioHealth> {
    let writable = false;
    const browserAdapter = await new PlaywrightBrowserProvider().health();
    const probe = join(workspace, `.health-${randomUUID()}`);
    try {
      await writeFile(probe, 'ok', { flag: 'wx', mode: 0o600 });
      await unlink(probe);
      writable = true;
    } catch {
      await rm(probe, { force: true });
    }
    const checks = {
      engine: typeof GenerationOrchestrator === 'function',
      browserAdapter,
      studioAssets: assets.has('/index.html') && [...assets].some(([path]) => path.endsWith('.js')),
      loopback: origin.startsWith('http://127.0.0.1:'),
      writable,
      workspaceContained: isContained(workspace, runsRoot),
    };
    return {
      status: Object.values(checks).every(Boolean) ? 'ready' : 'degraded',
      checks,
    };
  }

  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => accept());
  });
  const address = server.address() as AddressInfo;
  expectedHost = `127.0.0.1:${address.port}`;
  origin = `http://${expectedHost}`;

  const retentionTimer = setInterval(
    () => void purgeExpiredRuns(runs, runsRoot, retentionMs),
    Math.max(1_000, Math.min(60_000, Math.floor(retentionMs / 2))),
  );
  retentionTimer.unref();

  return {
    url: `${origin}/`,
    workspaceRoot: workspace,
    health,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(retentionTimer);
      const serverClosed = new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
      for (const run of runs.values()) run.controller?.abort();
      await Promise.allSettled([...runs.values()].map((run) => run.task).filter(Boolean));
      await Promise.allSettled([...runs.values()].map((run) => run.preview?.close()));
      await serverClosed;
    },
  };
}

async function requireStudioWorkspace(workspaceRoot: string): Promise<string> {
  const workspace = assertBroadRootSafe(workspaceRoot);
  await assertDirectoryNotLink(workspace, 'Studio workspace');
  parseMarker(JSON.parse(await readFile(join(workspace, MARKER_NAME), 'utf8')));
  const runsRoot = join(workspace, RUNS_NAME);
  await mkdir(runsRoot, { recursive: true, mode: 0o700 });
  const [realWorkspace, realRuns] = await Promise.all([realpath(workspace), realpath(runsRoot)]);
  if (!isContained(realWorkspace, realRuns)) {
    throw new SmartUiError('POLICY_VIOLATION', 'Studio runs directory escapes the workspace.');
  }
  return realWorkspace;
}

function assertBroadRootSafe(value: string): string {
  if (!isAbsolute(value)) {
    throw new SmartUiError('INVALID_INPUT', 'Studio workspace must be an absolute path.');
  }
  const workspace = resolve(value);
  if (workspace === parse(workspace).root || workspace === resolve(homedir())) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      'Studio refuses filesystem roots and the user home directory; choose a dedicated workspace.',
    );
  }
  return workspace;
}

async function assertDirectoryNotLink(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SmartUiError('POLICY_VIOLATION', `${label} must be a real directory.`);
  }
}

function parseMarker(value: unknown): { workspaceId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw markerError();
  const marker = value as Record<string, unknown>;
  if (
    marker['schemaVersion'] !== '1.0' ||
    typeof marker['workspaceId'] !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(marker['workspaceId'])
  ) {
    throw markerError();
  }
  return { workspaceId: marker['workspaceId'] };
}

function markerError(): SmartUiError {
  return new SmartUiError(
    'INVALID_INPUT',
    'Studio workspace marker is missing or invalid; initialize a dedicated workspace first.',
  );
}

async function loadStaticAssets(root: string): Promise<Map<string, StaticAsset>> {
  const files = new Map<string, StaticAsset>();
  const queue = [''];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of await readdir(join(root, current), { withFileTypes: true })) {
      const relativePath = current ? join(current, entry.name) : entry.name;
      const absolutePath = join(root, relativePath);
      if (entry.isSymbolicLink() || (await lstat(absolutePath)).isSymbolicLink()) {
        throw new SmartUiError('POLICY_VIOLATION', 'Studio production assets cannot use symlinks.');
      }
      if (entry.isDirectory()) queue.push(relativePath);
      else if (entry.isFile()) {
        const path = `/${relativePath.replaceAll('\\', '/')}`;
        files.set(path, {
          path,
          mediaType: staticMediaType(path),
          bytes: await readFile(absolutePath),
        });
      }
    }
  }
  if (!files.has('/index.html')) {
    throw new SmartUiError('NOT_FOUND', 'Packaged Studio index.html is missing.');
  }
  return files;
}

async function streamUpload(
  request: IncomingMessage,
  destination: string,
  limit: number,
): Promise<void> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && (declared < 1 || declared > limit)) {
    drain(request);
    throw new SmartUiError('INVALID_INPUT', `SVG upload must be from 1 to ${limit} bytes.`);
  }
  const temporary = `${destination}.uploading`;
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  let bytes = 0;
  try {
    for await (const chunkValue of request) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      bytes += chunk.byteLength;
      if (bytes > limit)
        throw new SmartUiError('INVALID_INPUT', `SVG upload exceeds ${limit} bytes.`);
      if (!output.write(chunk)) await once(output, 'drain');
    }
    if (bytes === 0) throw new SmartUiError('INVALID_INPUT', 'SVG upload cannot be empty.');
    output.end();
    await once(output, 'close');
    await rename(temporary, destination);
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBounded(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SmartUiError('INVALID_INPUT', 'Request body must be strict UTF-8 JSON.');
  }
}

async function readBounded(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    total += chunk.byteLength;
    if (total > limit) throw new SmartUiError('INVALID_INPUT', 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parsePreferences(value: unknown): RunPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SmartUiError('INVALID_INPUT', 'Generation preferences must be an object.');
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !['engine', 'mode', 'layout', 'instructions', 'improve'].includes(key))) {
    throw new SmartUiError('INVALID_INPUT', 'Generation preferences contain an unknown field.');
  }
  const engine = input['engine'] ?? 'agent';
  if (engine !== 'agent' && engine !== 'deterministic') {
    throw new SmartUiError('INVALID_INPUT', 'Engine must be agent or deterministic.');
  }
  if (!['exact', 'hybrid', 'semantic'].includes(String(input['mode']))) {
    throw new SmartUiError('INVALID_INPUT', 'Mode must be exact, hybrid, or semantic.');
  }
  if (!['fixed', 'responsive', 'component'].includes(String(input['layout']))) {
    throw new SmartUiError('INVALID_INPUT', 'Layout must be fixed, responsive, or component.');
  }
  const improve = input['improve'];
  if (improve !== undefined && typeof improve !== 'boolean') {
    throw new SmartUiError('INVALID_INPUT', 'Improve must be a boolean.');
  }
  const instructions = input['instructions'];
  if (
    instructions !== undefined &&
    (typeof instructions !== 'string' || instructions.length > 4_000)
  ) {
    throw new SmartUiError('INVALID_INPUT', 'Implementation note must be at most 4000 characters.');
  }
  return {
    engine: engine as 'agent' | 'deterministic',
    mode: input['mode'] as GenerationMode,
    layout: input['layout'] as GenerationLayout,
    improve: engine === 'agent' && improve !== false,
    ...(typeof instructions === 'string' && instructions.length > 0 ? { instructions } : {}),
  };
}

function parseDecision(value: unknown): {
  action: 'accept' | 'improve';
  round?: number;
  feedback?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SmartUiError('INVALID_INPUT', 'A decision must be an object.');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['action', 'round', 'feedback'].includes(key))) {
    throw new SmartUiError('INVALID_INPUT', 'The decision contains an unknown field.');
  }
  const action = input['action'];
  if (action !== 'accept' && action !== 'improve') {
    throw new SmartUiError('INVALID_INPUT', 'Decision action must be accept or improve.');
  }
  const round = input['round'];
  if (round !== undefined && (!Number.isInteger(round) || (round as number) < 1)) {
    throw new SmartUiError('INVALID_INPUT', 'Decision round must be a positive integer.');
  }
  const feedback = input['feedback'];
  if (feedback !== undefined && (typeof feedback !== 'string' || feedback.length > 4_000)) {
    throw new SmartUiError('INVALID_INPUT', 'Feedback must be at most 4000 characters.');
  }
  const trimmed = typeof feedback === 'string' ? feedback.trim() : '';
  if (action === 'improve' && round !== undefined) {
    throw new SmartUiError('INVALID_INPUT', 'Only an accepted decision names a round.');
  }
  return {
    action,
    ...(typeof round === 'number' ? { round } : {}),
    ...(trimmed ? { feedback: trimmed } : {}),
  };
}

function selectRecord(
  run: StudioRun,
  record: GenerationRecord,
  recordArtifactPath: string,
  artifactRoot: string,
): void {
  run.record = record;
  run.recordArtifactPath = recordArtifactPath;
  run.artifactRoot = artifactRoot;
}

/** Each round owns a new empty generation artifact root, as the orchestrator requires. */
function roundArtifactRoot(runRoot: string, round: number): string {
  return join(runRoot, 'artifacts', `round-${round}`);
}

function markAccepted(run: StudioRun, round: number): void {
  for (const item of run.rounds) item.accepted = item.round === round;
  run.acceptedRound = round;
}

function textHash(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Workspace-relative POSIX path of one artifact, so readers can re-verify containment. */
function workspaceRelativeArtifact(
  workspace: string,
  artifactRoot: string,
  relativePath: string,
): string {
  return relative(workspace, join(artifactRoot, relativePath)).split(sep).join('/');
}

/** Bounded deterministic evidence from one completed round, derived from its immutable record. */
function priorEvidence(run: StudioRun, round: RunRound): AuthoringPriorEvidence {
  const record = run.records.get(round.round);
  const pass = record ? [...record.passes].reverse().find((item) => item.accepted) : undefined;
  return {
    round: round.round,
    visualSimilarityPercent: round.visualSimilarity,
    visualMismatchPercent: round.visualMismatchPercent,
    ...(record?.input.finalMode ? { finalMode: record.input.finalMode } : {}),
    findings: (pass?.findings ?? []).slice(0, 20).map((finding) => ({
      category: finding.category.slice(0, 100),
      severity: finding.severity.slice(0, 50),
      message: finding.message.slice(0, 400),
    })),
    warnings: (record?.warnings ?? []).slice(0, 10).map((warning) => warning.slice(0, 400)),
  };
}

function runSummary(run: StudioRun, maxImproveRounds: number) {
  const record = run.record;
  const acceptedPass = record
    ? [...record.passes].reverse().find((pass) => pass.accepted)
    : undefined;
  return {
    runId: run.id,
    filename: run.filename,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    phase: run.phase,
    progress: run.progress,
    inspection: run.inspection,
    rounds: run.rounds.map((item) => ({
      round: item.round,
      createdAt: item.createdAt,
      engine: item.engine,
      authoringAgent: item.authoringAgent ?? null,
      feedback: item.feedback ?? null,
      responseHash: item.responseHash ?? null,
      visualSimilarity: item.visualSimilarity,
      visualMismatchPercent: item.visualMismatchPercent,
      accepted: item.accepted,
    })),
    selectedRound: run.selectedRound ?? null,
    acceptedRound: run.acceptedRound ?? null,
    decision:
      run.phase === 'awaiting-decision'
        ? {
            canImprove: run.rounds.length <= maxImproveRounds,
            remainingImproveRounds: Math.max(0, maxImproveRounds - run.rounds.length + 1),
            maxImproveRounds,
          }
        : null,
    pendingAuthoring: run.pending
      ? { round: run.pending.round, feedback: run.pending.feedback ?? null }
      : null,
    generation: record
      ? {
          generationId: record.id,
          status: record.status,
          stoppedReason: record.stoppedReason,
          engine: record.provenance.hostProposal ? 'agent' : 'deterministic',
          agent: record.provenance.hostProposal
            ? {
                host: record.provenance.host ?? 'agent',
                accepted: record.provenance.hostProposalAccepted ?? false,
              }
            : null,
          requestedMode: record.input.requestedMode,
          finalMode: record.input.finalMode,
          manifestHash: record.manifestHash,
          files: record.generatedFiles.map((file, index) => ({
            index,
            relativePath: file.relativePath,
            mediaType: file.mediaType,
            hash: file.hash,
            byteLength: file.byteLength,
          })),
          visualSimilarity: acceptedPass ? Math.max(0, 100 - acceptedPass.diffPercent) : null,
          visualMismatchPercent: acceptedPass?.diffPercent ?? null,
          uncertaintyCount: record.uncertainties.length,
          uncertainties: record.uncertainties.slice(0, 20),
          findings: acceptedPass?.findings.slice(0, 50) ?? [],
          viewports: record.viewports.map((item) => ({
            name: item.name,
            viewport: item.viewport,
            classification: item.classification,
            similarity: item.similarity,
            findingCount: item.findings.length,
          })),
          warnings: record.warnings.slice(0, 30),
          failures: record.failures,
          previewUrl: run.preview?.url ?? null,
          downloads: {
            archive: record.archive ? `/api/runs/${run.id}/download/archive` : null,
            report: record.report ? `/api/runs/${run.id}/download/report` : null,
          },
          evidence: acceptedPass
            ? {
                screenshot: `/api/runs/${run.id}/evidence/screenshot`,
                design: acceptedPass.reference
                  ? `/api/runs/${run.id}/evidence/design`
                  : `/api/runs/${run.id}/evidence/screenshot`,
                diff: `/api/runs/${run.id}/evidence/diff`,
                overlay: `/api/runs/${run.id}/evidence/overlay`,
              }
            : null,
        }
      : null,
    error: run.error,
  };
}

async function startRunPreview(run: StudioRun): Promise<void> {
  if (!run.record?.input.finalMode) return;
  await run.preview?.close();
  const store = new LocalArtifactStore(run.artifactRoot);
  const files = await Promise.all(
    run.record.generatedFiles.map(async (file) => ({
      relativePath: file.relativePath,
      mediaType: file.mediaType,
      bytes: await store.read(file.artifact.relativePath),
      rationale: file.rationale,
      sourceNodeIds: file.sourceNodeIds,
    })),
  );
  run.preview = await new LoopbackGeneratedPreviewProvider().serve({
    files,
    decisions: run.record.decisions,
    uncertainties: run.record.uncertainties,
    finalMode: run.record.input.finalMode,
  });
}

function generatedFile(run: StudioRun, indexValue: string | undefined) {
  const index = Number(indexValue);
  if (!Number.isInteger(index) || index < 0)
    throw new SmartUiError('NOT_FOUND', 'File was not found.');
  const file = run.record?.generatedFiles[index];
  if (!file) throw new SmartUiError('NOT_FOUND', 'File was not found.');
  return file;
}

async function download(
  run: StudioRun,
  segments: string[],
  response: ServerResponse,
  methodName: string | undefined,
): Promise<void> {
  if (!run.record) throw new SmartUiError('NOT_FOUND', 'Completed generation was not found.');
  let artifact: ArtifactRef | undefined;
  let name = 'download.bin';
  if (segments[0] === 'archive' && segments.length === 1) {
    artifact = run.record.archive;
    name = 'generated-ui.zip';
  } else if (segments[0] === 'report' && segments.length === 1) {
    artifact = run.record.report;
    name = 'generation-report.html';
  } else if (segments[0] === 'file' && segments.length === 2) {
    const file = generatedFile(run, segments[1]);
    artifact = file.artifact;
    name = basename(file.relativePath);
  }
  if (!artifact) throw new SmartUiError('NOT_FOUND', 'Download was not found.');
  const bytes = await new LocalArtifactStore(run.artifactRoot).read(artifact.relativePath);
  response.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName(name)}"`);
  binary(response, 200, artifact.mediaType, bytes, methodName);
}

async function evidence(
  run: StudioRun,
  kind: string,
  response: ServerResponse,
  methodName: string | undefined,
): Promise<void> {
  const pass = run.record
    ? [...run.record.passes].reverse().find((item) => item.accepted)
    : undefined;
  const artifact =
    kind === 'screenshot'
      ? pass?.screenshot
      : kind === 'design'
        ? (pass?.reference ?? pass?.screenshot)
        : kind === 'diff'
          ? pass?.diff
          : kind === 'overlay'
            ? pass?.overlay
            : undefined;
  if (!artifact) throw new SmartUiError('NOT_FOUND', 'Evidence was not found.');
  const bytes = await new LocalArtifactStore(run.artifactRoot).read(artifact.relativePath);
  binary(response, 200, artifact.mediaType, bytes, methodName);
}

async function persistRun(run: StudioRun): Promise<void> {
  const value: PersistedRun = {
    schemaVersion: '1.0',
    runId: run.id,
    filename: run.filename,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    phase: run.phase,
    progress: run.progress,
    ...(run.inspection ? { inspection: run.inspection } : {}),
    ...(run.preferences ? { preferences: run.preferences } : {}),
    ...(run.rounds.length > 0 ? { rounds: run.rounds } : {}),
    ...(run.selectedRound ? { selectedRound: run.selectedRound } : {}),
    ...(run.acceptedRound ? { acceptedRound: run.acceptedRound } : {}),
    ...(run.recordArtifactPath ? { recordArtifactPath: run.recordArtifactPath } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
  const temporary = join(run.root, `${POINTER_NAME}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(run.root, POINTER_NAME));
}

async function recoverRuns(
  workspace: string,
  runs: Map<string, StudioRun>,
  retentionMs: number,
): Promise<void> {
  const runsRoot = join(workspace, RUNS_NAME);
  const now = Date.now();
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID.test(entry.name)) continue;
    const root = join(runsRoot, entry.name);
    try {
      await assertDirectoryNotLink(root, 'Studio run');
      const pointer = parsePersistedRun(
        JSON.parse(await readFile(join(root, POINTER_NAME), 'utf8')),
      );
      if (pointer.runId !== entry.name) throw new Error('run identity mismatch');
      if (now - new Date(pointer.updatedAt).getTime() > retentionMs) {
        await rm(root, { recursive: true, force: true });
        continue;
      }
      const run: StudioRun = {
        id: pointer.runId,
        root,
        artifactRoot: roundArtifactRoot(root, pointer.selectedRound ?? 1),
        uploadPath: join(root, 'input', 'upload.svg'),
        filename: pointer.filename,
        createdAt: pointer.createdAt,
        updatedAt: pointer.updatedAt,
        phase: isActivePhase(pointer.phase) ? 'interrupted' : pointer.phase,
        progress: isActivePhase(pointer.phase)
          ? { stage: 'interrupted', value: 1, message: 'The previous Studio process exited.' }
          : pointer.progress,
        ...(pointer.inspection ? { inspection: pointer.inspection } : {}),
        ...(pointer.preferences ? { preferences: pointer.preferences } : {}),
        rounds: pointer.rounds ?? [],
        records: new Map<number, GenerationRecord>(),
        ...(pointer.selectedRound ? { selectedRound: pointer.selectedRound } : {}),
        ...(pointer.acceptedRound ? { acceptedRound: pointer.acceptedRound } : {}),
        ...(pointer.recordArtifactPath ? { recordArtifactPath: pointer.recordArtifactPath } : {}),
        ...(pointer.error ? { error: pointer.error } : {}),
        controller: undefined,
        task: undefined,
      };
      for (const item of run.rounds) {
        const bytes = await new LocalArtifactStore(roundArtifactRoot(root, item.round)).read(
          item.recordArtifactPath,
        );
        run.records.set(
          item.round,
          generationRecordSchema.parse(JSON.parse(new TextDecoder().decode(bytes))),
        );
      }
      if (pointer.recordArtifactPath) {
        const bytes = await new LocalArtifactStore(run.artifactRoot).read(
          pointer.recordArtifactPath,
        );
        run.record = generationRecordSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        if (run.record.generatedFiles.length > 0) await startRunPreview(run);
      }
      runs.set(run.id, run);
      if (run.phase === 'interrupted') await persistRun(run);
    } catch {
      // A malformed directory is not exposed. It remains available for manual support recovery.
    }
  }
}

function parsePersistedRun(value: unknown): PersistedRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid run');
  const run = value as Record<string, unknown>;
  if (
    run['schemaVersion'] !== '1.0' ||
    typeof run['runId'] !== 'string' ||
    !RUN_ID.test(run['runId']) ||
    typeof run['filename'] !== 'string' ||
    typeof run['createdAt'] !== 'string' ||
    !Number.isFinite(Date.parse(run['createdAt'])) ||
    typeof run['updatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(run['updatedAt'])) ||
    !RUN_PHASES.includes(String(run['phase']) as RunPhase) ||
    !run['progress'] ||
    typeof run['progress'] !== 'object'
  ) {
    throw new Error('invalid run');
  }
  const rounds = run['rounds'];
  if (rounds !== undefined) {
    if (!Array.isArray(rounds)) throw new Error('invalid rounds');
    for (const [index, item] of rounds.entries()) {
      if (
        !item ||
        typeof item !== 'object' ||
        (item as RunRound).round !== index + 1 ||
        typeof (item as RunRound).recordArtifactPath !== 'string' ||
        !RECORD_PATH.test((item as RunRound).recordArtifactPath)
      ) {
        throw new Error('invalid round');
      }
    }
  }
  const recordArtifactPath = run['recordArtifactPath'];
  if (
    recordArtifactPath !== undefined &&
    (typeof recordArtifactPath !== 'string' || !RECORD_PATH.test(recordArtifactPath))
  ) {
    throw new Error('invalid record path');
  }
  return run as unknown as PersistedRun;
}

async function deleteRun(run: StudioRun, runsRoot: string): Promise<void> {
  run.controller?.abort();
  if (run.task) await run.task;
  await run.preview?.close();
  const target = resolve(run.root);
  if (
    !RUN_ID.test(basename(target)) ||
    dirname(target) !== resolve(runsRoot) ||
    !isContained(runsRoot, target)
  ) {
    throw new SmartUiError('POLICY_VIOLATION', 'Resolved Studio run deletion target is invalid.');
  }
  await assertDirectoryNotLink(target, 'Studio run deletion target');
  await rm(target, { recursive: true });
  try {
    await access(target);
    throw new SmartUiError('PROVIDER_FAILURE', 'Studio run deletion could not be verified.');
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function purgeExpiredRuns(
  runs: Map<string, StudioRun>,
  runsRoot: string,
  retentionMs: number,
): Promise<void> {
  const threshold = Date.now() - retentionMs;
  for (const run of [...runs.values()]) {
    if (isActivePhase(run.phase) || new Date(run.updatedAt).getTime() >= threshold) continue;
    try {
      await deleteRun(run, runsRoot);
      runs.delete(run.id);
    } catch {
      // Retention retries on the next bounded interval.
    }
  }
}

function requireSession(request: IncomingMessage, capability: string): void {
  const cookies = Object.fromEntries(
    (request.headers.cookie ?? '')
      .split(';')
      .map((item) => item.trim().split('='))
      .filter((item): item is [string, string] => item.length === 2),
  );
  if (cookies[COOKIE_NAME] !== capability) {
    throw new SmartUiError('POLICY_VIOLATION', 'Studio session capability is missing or invalid.');
  }
}

function requireSameSiteFetch(request: IncomingMessage): void {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw new SmartUiError('POLICY_VIOLATION', 'Cross-site Studio requests are not allowed.');
  }
}

function requireApiRequest(request: IncomingMessage, origin: string, csrf: string): void {
  requireSameSiteFetch(request);
  if (request.headers['x-smart-ui-csrf'] !== csrf) {
    throw new SmartUiError('POLICY_VIOLATION', 'Studio CSRF token is missing or invalid.');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.origin !== origin) {
    throw new SmartUiError('POLICY_VIOLATION', 'Studio request Origin is missing or invalid.');
  }
}

function exactContentType(request: IncomingMessage, expected: string): void {
  if (request.headers['content-type'] !== expected) {
    drain(request);
    throw new SmartUiError('INVALID_INPUT', `Content-Type must be exactly ${expected}.`);
  }
}

function parseRequestUrl(value: string | undefined): URL {
  try {
    const url = new URL(value ?? '/', 'http://127.0.0.1');
    if (url.search || url.hash || url.username || url.password) throw new Error('unsupported URL');
    return url;
  } catch {
    throw new SmartUiError('INVALID_INPUT', 'Request URL is invalid.');
  }
}

function uploadFilename(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200)
    return 'uploaded-design.svg';
  const name = [...basename(value)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('');
  return extname(name).toLowerCase() === '.svg' && name.length > 4 ? name : 'uploaded-design.svg';
}

function safeDownloadName(value: string): string {
  return (
    basename(value)
      .replaceAll(/[^a-zA-Z0-9._-]/gu, '_')
      .slice(0, 120) || 'download.bin'
  );
}

function boundedRetention(value: number): number {
  if (!Number.isFinite(value) || value < 1_000 || value > 30 * 24 * 60 * 60 * 1_000) {
    throw new SmartUiError('INVALID_INPUT', 'Studio retention must be from 1 second to 30 days.');
  }
  return Math.floor(value);
}

function boundedAgentTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AUTHORING_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 1_000 || value > 60 * 60 * 1_000) {
    throw new SmartUiError(
      'INVALID_INPUT',
      'Studio agent timeout must be from 1 second to 60 minutes.',
    );
  }
  return Math.floor(value);
}

function boundedImproveRounds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_IMPROVE_ROUNDS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_AUTHORING_ROUNDS - 1) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `Studio improvement rounds must be an integer from 0 to ${MAX_AUTHORING_ROUNDS - 1}.`,
    );
  }
  return value;
}

function isContained(root: string, target: string): boolean {
  const result = relative(resolve(root), resolve(target));
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function publicFailure(error: unknown, workspace: string) {
  const code = error instanceof SmartUiError ? error.code : 'PROVIDER_FAILURE';
  const raw = error instanceof Error ? error.message : 'Studio operation failed.';
  const message = raw
    .replaceAll(resolve(workspace), '[workspace]')
    .replaceAll(resolve(homedir()), '[home]')
    .slice(0, 1_000);
  const status =
    code === 'NOT_FOUND'
      ? 404
      : code === 'POLICY_VIOLATION'
        ? 403
        : code === 'INVALID_INPUT'
          ? 400
          : 500;
  return {
    code,
    status,
    message,
    recovery:
      code === 'INVALID_INPUT'
        ? 'Review the SVG or preferences and start a new run.'
        : code === 'POLICY_VIOLATION'
          ? 'Use the dedicated Studio workspace and retry from the same local origin.'
          : code === 'NOT_FOUND'
            ? 'Refresh the run list; the run may have expired or been deleted.'
            : 'Review the local report and health check, then retry in a new run.',
  };
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', STUDIO_CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function serveAsset(
  response: ServerResponse,
  methodName: string | undefined,
  asset: StaticAsset | undefined,
): void {
  if (!asset) return text(response, 404, 'Not found');
  binary(response, 200, asset.mediaType, asset.bytes, methodName);
}

function binary(
  response: ServerResponse,
  status: number,
  mediaType: string,
  bytes: Uint8Array,
  methodName?: string,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', mediaType);
  response.setHeader('Content-Length', String(bytes.byteLength));
  if (methodName === 'HEAD') response.end();
  else response.end(Buffer.from(bytes));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(body.byteLength));
  response.end(body);
}

function text(response: ServerResponse, status: number, value: string): void {
  const body = Buffer.from(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', String(body.byteLength));
  response.end(body);
}

function method(response: ServerResponse, allow: string): void {
  response.setHeader('Allow', allow);
  text(response, 405, 'Method not allowed');
}

function drain(request: IncomingMessage): void {
  request.resume();
}

function staticMediaType(path: string): string {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    }[extname(path).toLowerCase()] ?? 'application/octet-stream'
  );
}

function isTextMediaType(mediaType: string): boolean {
  return ['text/html', 'text/css', 'text/plain', 'image/svg+xml'].includes(mediaType);
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
