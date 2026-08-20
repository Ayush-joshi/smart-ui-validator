import React, { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

type Phase =
  | 'inspected'
  | 'generating'
  | 'awaiting-agent'
  | 'awaiting-agent-revision'
  | 'awaiting-decision'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted';

interface RunRoundSummary {
  round: number;
  createdAt: string;
  engine: Engine;
  authoringAgent: string | null;
  feedback: string | null;
  responseHash: string | null;
  visualSimilarity: number | null;
  visualMismatchPercent: number | null;
  accepted: boolean;
}

interface RunSummary {
  runId: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  progress: { stage: string; value: number; message: string };
  rounds: RunRoundSummary[];
  selectedRound: number | null;
  acceptedRound: number | null;
  decision: null | {
    canImprove: boolean;
    remainingImproveRounds: number;
    maxImproveRounds: number;
  };
  pendingAuthoring: null | { round: number; feedback: string | null };
  designContext: null | {
    filename: string;
    mediaType: string;
    originalHash: string;
    byteLength: number;
  };
  inspection?: {
    filename: string;
    mediaType?: 'image/svg+xml' | 'image/png';
    byteLength?: number;
    width: number;
    height: number;
    readableTextNodes: number;
    originalInputHash: string;
    sanitizedHash: string;
    sanitization: { accepted: boolean; nodeCount: number; decisions: string[] };
    uncertaintyCount: number;
    recommendedModes: Mode[];
  };
  preferences: null | {
    presentationSpec: PresentationSpec;
    structuredDesignContext: StructuredDesignContext;
  };
  generation: null | {
    generationId: string;
    status: string;
    stoppedReason: string;
    engine: Engine;
    agent: null | { host: string; accepted: boolean };
    requestedMode: Mode;
    finalMode?: Mode;
    presentationSpec: PresentationSpec | null;
    structuredContextHash: string | null;
    manifestHash?: string;
    files: Array<{
      index: number;
      relativePath: string;
      mediaType: string;
      hash: string;
      byteLength: number;
    }>;
    visualSimilarity: number | null;
    visualMismatchPercent: number | null;
    uncertaintyCount: number;
    uncertainties: Array<{ code: string; message: string; confidence: number }>;
    findings: Array<{ id: string; category: string; severity: string; message: string }>;
    viewports: Array<{
      name: string;
      viewport: { width: number; height: number };
      classification: string;
      similarity?: number;
      findingCount: number;
    }>;
    warnings: string[];
    failures: Array<{ code: string; message: string }>;
    previewUrl: string | null;
    downloads: { archive: string | null; report: string | null };
    evidence: null | { screenshot: string; design: string; diff: string; overlay: string };
  };
  error?: { code: string; message: string; recovery: string };
}

type Mode = 'exact' | 'hybrid' | 'semantic';
type Layout = 'fixed' | 'responsive' | 'component';
type Engine = 'agent' | 'deterministic';
type WorkType = 'generate' | 'validate';
type Step = 'work-type' | 'inputs' | 'boundaries' | 'handoff' | 'review';
type ContextMode = 'upload' | 'paste';
type Fit = 'intrinsic' | 'contain' | 'cover' | 'stretch';
type Alignment = 'start' | 'center' | 'end';
const defaultImplementationRoute = 'http://127.0.0.1:4173/';
const defaultImplementationWrites = 'src/App.tsx';
interface PresentationViewport {
  id: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
}
interface PresentationSpec {
  schemaVersion: '1.0';
  primaryCanvas: PresentationViewport;
  fit: Fit;
  horizontalAlignment: Alignment;
  verticalAlignment: Alignment;
  viewports: Array<PresentationViewport & { requirement: 'required' | 'advisory' }>;
}
interface StructuredDesignContext {
  schemaVersion: '1.0';
  exactCopy: Array<{
    id: string;
    label: string;
    text: string;
    locale?: string;
    sourceNodeIds: string[];
    provenance: string;
  }>;
  designTokens: Array<{
    name: string;
    kind: 'color' | 'typography' | 'spacing' | 'radius' | 'border' | 'shadow' | 'other';
    value: string;
    usage?: string;
    provenance: string;
  }>;
  componentSemantics: Array<{
    id: string;
    name: string;
    role: string;
    stateOrVariant?: string;
    sourceNodeIds: string[];
    provenance: string;
  }>;
  interactions: Array<{
    id: string;
    trigger: string;
    target: string;
    resultingBehavior: string;
    keyboardNotes?: string;
    sourceNodeIds: string[];
    provenance: string;
  }>;
  generalNotes?: string;
}

const emptyContext = (): StructuredDesignContext => ({
  schemaVersion: '1.0',
  exactCopy: [],
  designTokens: [],
  componentSemantics: [],
  interactions: [],
});

interface SessionResponse {
  csrfToken: string;
  runs: RunSummary[];
  limits: { maxUploadBytes: number; maxDesignContextBytes: number };
  agent: { configured: boolean; transport: 'mcp'; workspace: string; maxImproveRounds: number };
  handoff: {
    targetEnabled: boolean;
    targetRoot: string | null;
    restartCommand: string | null;
    tasks: HandoffTaskView[];
  };
}

export interface HandoffTaskView {
  taskId: string;
  taskType: 'generation' | 'validate-ui';
  taskHash: string;
  taskFile: string;
  status: string;
  revision: number;
  activeAttempt: number | null;
  acceptedAttempt: number | null;
  writableFiles: string[];
  route: string | null;
  attempt: null | {
    number: number;
    outcome: string;
    findingCount: number;
    blockingFindingCount: number;
    revisionGuidance: string[];
    generation: null | { visualSimilarityPercent: number | null; reportPath: string | null };
    implementation: null | {
      changedFiles: string[];
      cells: Array<{
        viewport: string;
        state: string;
        classification: string;
        score: number | null;
      }>;
    };
  };
  commands: { review: string; status: string; accept: string; cancel: string; mcp: string };
}

interface SourceFile {
  relativePath: string;
  mediaType: string;
  source: string;
}

export function StudioApp(): ReactNode {
  const [session, setSession] = useState<SessionResponse>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [handoffTasks, setHandoffTasks] = useState<HandoffTaskView[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [activeTaskId, setActiveTaskId] = useState<string>();
  const [workType, setWorkType] = useState<WorkType>();
  const [step, setStep] = useState<Step>('work-type');
  const [contextMode, setContextMode] = useState<ContextMode>('upload');
  const [contextText, setContextText] = useState('');
  const [engine, setEngine] = useState<Engine>('agent');
  const [mode, setMode] = useState<Mode>('hybrid');
  const [layout, setLayout] = useState<Layout>('responsive');
  const [instructions, setInstructions] = useState('');
  const [structuredContext, setStructuredContext] = useState<StructuredDesignContext>(emptyContext);
  const [customCanvas, setCustomCanvas] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(1);
  const [canvasHeight, setCanvasHeight] = useState(1);
  const [canvasDpr, setCanvasDpr] = useState(1);
  const [fit, setFit] = useState<Fit>('intrinsic');
  const [horizontalAlignment, setHorizontalAlignment] = useState<Alignment>('start');
  const [verticalAlignment, setVerticalAlignment] = useState<Alignment>('start');
  const [validationViewports, setValidationViewports] = useState<PresentationSpec['viewports']>([]);
  const [improve, setImprove] = useState(true);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; recovery?: string }>();
  const [source, setSource] = useState<SourceFile>();
  const [pendingDesignContext, setPendingDesignContext] = useState<File>();
  const [implementationDesignFile, setImplementationDesignFile] = useState<File>();
  const [implementationRoute, setImplementationRoute] = useState(defaultImplementationRoute);
  const [implementationWrites, setImplementationWrites] = useState(defaultImplementationWrites);
  const [implementationPresentationPath, setImplementationPresentationPath] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const active = runs.find((run) => run.runId === activeId);
  const activeTask = handoffTasks.find((task) => task.taskId === activeTaskId);
  const cleanupDecisions =
    active?.inspection?.sanitization.decisions.filter((decision) =>
      decision.startsWith('Removed '),
    ) ?? [];

  useEffect(() => {
    void fetch('/api/session', { credentials: 'same-origin' })
      .then(readResponse<SessionResponse>)
      .then((value) => {
        setSession(value);
        setRuns(value.runs);
        setHandoffTasks(value.handoff.tasks);
        if (!value.agent.configured) setEngine('deterministic');
      })
      .catch(showFailure(setError));
  }, []);

  useEffect(() => {
    if (!session || !isRunning(active?.phase)) return;
    const timer = window.setInterval(() => {
      void api<RunSummary>(`/api/runs/${active!.runId}`, session.csrfToken)
        .then((run) => {
          setRuns((current) => replaceRun(current, run));
          if (!isRunning(run.phase)) setStep('review');
        })
        .catch(showFailure(setError));
    }, 400);
    return () => window.clearInterval(timer);
  }, [active?.phase, active?.runId, session]);

  useEffect(() => {
    if (!session || handoffTasks.length === 0) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void api<HandoffTaskView[]>('/api/tasks', session.csrfToken)
        .then((tasks) => {
          if (!disposed) setHandoffTasks(tasks);
        })
        .catch(showFailure(setError));
    }, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [handoffTasks.length, session]);

  async function decideTask(task: HandoffTaskView, action: 'accept' | 'cancel'): Promise<void> {
    if (!session || (action === 'accept' && !task.activeAttempt)) return;
    const updated = await api<HandoffTaskView>(
      `/api/tasks/${task.taskId}/decision`,
      session.csrfToken,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, attempt: task.activeAttempt ?? 1 }),
      },
    );
    setHandoffTasks((current) =>
      current.map((item) => (item.taskId === updated.taskId ? updated : item)),
    );
  }

  async function unregisterTask(task: HandoffTaskView): Promise<void> {
    if (!session) return;
    await api(`/api/tasks/${task.taskId}`, session.csrfToken, { method: 'DELETE' });
    setHandoffTasks((current) => current.filter((item) => item.taskId !== task.taskId));
    if (activeTaskId === task.taskId) {
      setActiveTaskId(undefined);
      setWorkType(undefined);
      setStep('work-type');
    }
  }

  async function prepareImplementationHandoff(): Promise<void> {
    if (!session?.handoff.targetEnabled || !implementationDesignFile) return;
    setBusy(true);
    setError(undefined);
    try {
      const lowerName = implementationDesignFile.name.toLowerCase();
      if (!lowerName.endsWith('.svg') && !lowerName.endsWith('.png')) {
        throw new Error('Choose one .svg or .png file.');
      }
      if (implementationDesignFile.size > session.limits.maxUploadBytes) {
        throw new Error(
          `Design reference exceeds the ${formatBytes(session.limits.maxUploadBytes)} limit.`,
        );
      }
      const uploadedDesign = await api<{ designPath: string }>(
        '/api/tasks/validate-ui/design',
        session.csrfToken,
        {
          method: 'POST',
          headers: {
            'Content-Type': lowerName.endsWith('.png') ? 'image/png' : 'image/svg+xml',
            'X-Smart-UI-Filename': implementationDesignFile.name,
          },
          body: implementationDesignFile,
        },
      );
      const uploadedContext =
        contextMode === 'upload' && pendingDesignContext
          ? await pendingDesignContext.text()
          : contextText;
      if (uploadedContext.length > 4_000) {
        throw new Error('Validate UI context must be 4,000 characters or fewer.');
      }
      const task = await api<HandoffTaskView>('/api/tasks/validate-ui', session.csrfToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          designPath: uploadedDesign.designPath,
          route: implementationRoute.trim(),
          writableFiles: implementationWrites
            .split(/\r?\n/u)
            .map((value) => value.trim())
            .filter(Boolean),
          ...(implementationPresentationPath.trim()
            ? { presentationPath: implementationPresentationPath.trim() }
            : {}),
          ...(uploadedContext.trim() ? { instructions: uploadedContext.trim() } : {}),
        }),
      });
      setHandoffTasks((current) => [
        ...current.filter((item) => item.taskId !== task.taskId),
        task,
      ]);
      setActiveTaskId(task.taskId);
      setImplementationDesignFile(undefined);
      setStep('handoff');
    } catch (value) {
      showFailure(setError)(value);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File): Promise<void> {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    setSource(undefined);
    try {
      const lowerName = file.name.toLowerCase();
      const mediaType = lowerName.endsWith('.png') ? 'image/png' : 'image/svg+xml';
      if (!lowerName.endsWith('.svg') && !lowerName.endsWith('.png')) {
        throw new Error('Choose one .svg or .png file.');
      }
      if (file.size > session.limits.maxUploadBytes) {
        throw new Error(
          `Design reference exceeds the ${formatBytes(session.limits.maxUploadBytes)} limit.`,
        );
      }
      const run = await api<RunSummary>('/api/runs', session.csrfToken, {
        method: 'POST',
        headers: { 'Content-Type': mediaType, 'X-Smart-UI-Filename': file.name },
        body: file,
      });
      setRuns((current) => [...current, run]);
      setActiveId(run.runId);
      setMode(engine === 'agent' ? 'semantic' : (run.inspection?.recommendedModes[0] ?? 'hybrid'));
      setCanvasWidth(run.inspection?.width ?? 1);
      setCanvasHeight(run.inspection?.height ?? 1);
      setStep('boundaries');
      const designContext =
        contextMode === 'paste' && contextText.trim()
          ? new File([contextText], 'pasted-design-context.txt', { type: 'text/plain' })
          : pendingDesignContext;
      if (designContext) {
        if (designContext.size > session.limits.maxDesignContextBytes) {
          throw new Error(
            `Design context exceeds the ${formatBytes(session.limits.maxDesignContextBytes)} limit.`,
          );
        }
        const preparedRun = await api<RunSummary>(
          `/api/runs/${run.runId}/design-context`,
          session.csrfToken,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Smart-UI-Filename': designContext.name,
              'X-Smart-UI-Context-Type': designContext.type || 'text/plain',
            },
            body: designContext,
          },
        );
        setRuns((current) => replaceRun(current, preparedRun));
        setPendingDesignContext(undefined);
      }
    } catch (value) {
      showFailure(setError)(value);
    } finally {
      setBusy(false);
    }
  }

  async function generate(): Promise<void> {
    if (!session || !active) return;
    setBusy(true);
    setError(undefined);
    try {
      const run = await api<RunSummary>(`/api/runs/${active.runId}/generate`, session.csrfToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentPreferences()),
      });
      setRuns((current) => replaceRun(current, run));
      setStep('handoff');
    } catch (value) {
      showFailure(setError)(value);
    } finally {
      setBusy(false);
    }
  }

  async function prepareHandoff(): Promise<void> {
    if (!session || !active) return;
    setBusy(true);
    setError(undefined);
    try {
      const task = await api<HandoffTaskView>(
        `/api/runs/${active.runId}/handoff`,
        session.csrfToken,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentPreferences()),
        },
      );
      setHandoffTasks((current) => [
        ...current.filter((item) => item.taskId !== task.taskId),
        task,
      ]);
      setActiveTaskId(task.taskId);
      setStep('handoff');
    } catch (value) {
      showFailure(setError)(value);
    } finally {
      setBusy(false);
    }
  }

  function currentPreferences() {
    const sourceWidth = active?.inspection?.width ?? canvasWidth;
    const sourceHeight = active?.inspection?.height ?? canvasHeight;
    return {
      engine,
      mode,
      layout,
      improve,
      ...(instructions.trim() ? { instructions } : {}),
      structuredDesignContext: {
        ...structuredContext,
        ...(instructions.trim() ? { generalNotes: instructions } : {}),
      },
      presentationSpec: {
        schemaVersion: '1.0' as const,
        primaryCanvas: {
          id: customCanvas ? 'primary' : 'source',
          width: customCanvas ? canvasWidth : sourceWidth,
          height: customCanvas ? canvasHeight : sourceHeight,
          deviceScaleFactor: canvasDpr,
        },
        fit: customCanvas ? fit : 'intrinsic',
        horizontalAlignment: customCanvas ? horizontalAlignment : 'start',
        verticalAlignment: customCanvas ? verticalAlignment : 'start',
        viewports: validationViewports,
      },
    };
  }

  async function uploadDesignContext(file: File): Promise<void> {
    if (!session || !active) return;
    setBusy(true);
    setError(undefined);
    try {
      if (file.size > session.limits.maxDesignContextBytes) {
        throw new Error(
          `Design context exceeds the ${formatBytes(session.limits.maxDesignContextBytes)} limit.`,
        );
      }
      const run = await api<RunSummary>(
        `/api/runs/${active.runId}/design-context`,
        session.csrfToken,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Smart-UI-Filename': file.name,
            'X-Smart-UI-Context-Type': file.type || 'text/plain',
          },
          body: file,
        },
      );
      setRuns((current) => replaceRun(current, run));
    } catch (value) {
      showFailure(setError)(value);
    } finally {
      setBusy(false);
    }
  }

  async function decide(action: 'accept' | 'improve', round?: number): Promise<void> {
    if (!session || !active) return;
    setBusy(true);
    setError(undefined);
    try {
      const run = await api<RunSummary>(`/api/runs/${active.runId}/decision`, session.csrfToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'accept' && round !== undefined ? { round } : {}),
          ...(action === 'improve' && feedback.trim() ? { feedback } : {}),
        }),
      });
      setRuns((current) => replaceRun(current, run));
      setSource(undefined);
      if (action === 'improve') {
        setFeedback('');
        setStep('handoff');
      }
    } catch (value) {
      showFailure(setError)(value);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!session || !active) return;
    await api(`/api/runs/${active.runId}/cancel`, session.csrfToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(showFailure(setError));
  }

  async function removeRun(): Promise<void> {
    if (!session || !active || !window.confirm('Delete this one local Studio run?')) return;
    await api(`/api/runs/${active.runId}`, session.csrfToken, { method: 'DELETE' })
      .then(() => {
        setRuns((current) => current.filter((run) => run.runId !== active.runId));
        newRun();
      })
      .catch(showFailure(setError));
  }

  async function openSource(index: number): Promise<void> {
    if (!session || !active) return;
    setSource(undefined);
    await api<SourceFile>(`/api/runs/${active.runId}/files/${index}`, session.csrfToken)
      .then(setSource)
      .catch(showFailure(setError));
  }

  async function clearLocalHistory(): Promise<void> {
    if (
      !session ||
      !window.confirm(
        'Delete all local Studio runs and remove task associations from Studio? Target repository files and task files will remain intact.',
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/work', session.csrfToken, { method: 'DELETE' });
      setRuns([]);
      setHandoffTasks([]);
      newRun(true);
    } catch (value) {
      showFailure(setError)(value);
    } finally {
      setBusy(false);
    }
  }

  function newRun(resetWorkType = false): void {
    setActiveId(undefined);
    setActiveTaskId(undefined);
    if (resetWorkType) setWorkType(undefined);
    setStep(resetWorkType ? 'work-type' : 'inputs');
    setEngine(session?.agent.configured ? 'agent' : 'deterministic');
    setMode('hybrid');
    setLayout('responsive');
    setInstructions('');
    setStructuredContext(emptyContext());
    setCustomCanvas(false);
    setCanvasWidth(1);
    setCanvasHeight(1);
    setCanvasDpr(1);
    setFit('intrinsic');
    setHorizontalAlignment('start');
    setVerticalAlignment('start');
    setValidationViewports([]);
    setImprove(true);
    setFeedback('');
    setSource(undefined);
    setPendingDesignContext(undefined);
    setImplementationDesignFile(undefined);
    setImplementationRoute(defaultImplementationRoute);
    setImplementationWrites(defaultImplementationWrites);
    setContextMode('upload');
    setContextText('');
    setImplementationPresentationPath('');
    setError(undefined);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local UI engineering workspace</p>
          <h1>Smart UI Studio</h1>
        </div>
        <div className="top-actions">
          <span className="local-badge">127.0.0.1 · telemetry off</span>
          <button disabled={busy} onClick={() => newRun(true)}>
            Reset workflow
          </button>
        </div>
      </header>

      {workType && (
        <nav className="steps" aria-label="Studio workflow steps">
          {(['work-type', 'inputs', 'boundaries', 'handoff', 'review'] as Step[]).map(
            (item, index) => (
              <button
                key={item}
                className={step === item ? 'active' : ''}
                disabled={!canVisit(item, workType, active, activeTask)}
                aria-current={step === item ? 'step' : undefined}
                onClick={() => {
                  if (shouldResetWorkflow(item)) newRun(true);
                  else setStep(item);
                }}
              >
                <span>{index + 1}</span> {title(item)}
              </button>
            ),
          )}
        </nav>
      )}

      {error && (
        <div className="alert" role="alert">
          <strong>{error.message}</strong>
          {error.recovery && <p>{error.recovery}</p>}
        </div>
      )}

      <main>
        {step === 'work-type' && (
          <section className="work-picker" aria-labelledby="work-type-title">
            <p className="eyebrow">Start a workflow</p>
            <h2 id="work-type-title">What are you working on?</h2>
            <p className="lede">Choose a work type. Both follow the same bounded review flow.</p>
            <div className="work-type-grid">
              <button
                className="work-type-card"
                onClick={() => {
                  setWorkType('generate');
                  setStep('inputs');
                }}
              >
                <span className="work-type-mark">01</span>
                <strong>Generate UI</strong>
                <span>
                  Create a standalone, offline HTML and CSS bundle from SVG or PNG evidence.
                </span>
                <small>Available</small>
              </button>
              <button
                className="work-type-card"
                disabled={!session?.handoff.targetEnabled}
                onClick={() => {
                  setWorkType('validate');
                  setStep('inputs');
                }}
              >
                <span className="work-type-mark">02</span>
                <strong>Validate UI</strong>
                <span>
                  Implement or review exact files in the configured React or Angular target.
                </span>
                <small>{session?.handoff.targetEnabled ? 'Available' : 'Target required'}</small>
              </button>
            </div>
            {!session?.handoff.targetEnabled && session?.handoff.restartCommand && (
              <div className="restart-note">
                <strong>Validate UI is unavailable.</strong>
                <span>Restart Studio with an explicit target:</span>
                <code>{session.handoff.restartCommand}</code>
              </div>
            )}
            {hasRecentWork(runs.length, handoffTasks.length) && (
              <div className="recent-work">
                <div className="editor-heading">
                  <h3>Recent work</h3>
                  <button disabled={busy} onClick={() => void clearLocalHistory()}>
                    Clear local history
                  </button>
                </div>
                <div className="recent-work-list">
                  {runs.map((run) => (
                    <button
                      key={run.runId}
                      onClick={() => {
                        setWorkType('generate');
                        setActiveId(run.runId);
                        setStep(stepFor(run));
                      }}
                    >
                      <span>
                        <strong>{run.filename}</strong>
                        <small>Generate UI</small>
                      </span>
                      <span className="status-pill">{run.phase}</span>
                    </button>
                  ))}
                  {handoffTasks.map((task) => (
                    <button
                      key={task.taskId}
                      onClick={() => {
                        setWorkType(task.taskType === 'generation' ? 'generate' : 'validate');
                        setActiveTaskId(task.taskId);
                        setStep(task.attempt ? 'review' : 'handoff');
                      }}
                    >
                      <span>
                        <strong>{task.taskId}</strong>
                        <small>{task.taskType}</small>
                      </span>
                      <span className="status-pill">{task.status}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {step === 'inputs' && workType === 'generate' && (
          <section className="panel input-panel" aria-labelledby="input-title">
            <p className="eyebrow">Step 2 · Inputs</p>
            <h2 id="input-title">Choose design inputs</h2>
            <p className="lede">
              Add the required SVG or PNG reference and, when available, its accompanying design
              context. With the agent engine, both are passed to the authoring agent.
            </p>
            <div className="input-file-grid single-reference">
              <DesignReferenceInput
                inputRef={inputRef}
                busy={busy}
                maxBytes={session?.limits.maxUploadBytes}
                onFile={(file) => void upload(file)}
              />
            </div>
            <ContextInput
              mode={contextMode}
              file={pendingDesignContext}
              text={contextText}
              maxBytes={session?.limits.maxDesignContextBytes}
              onMode={setContextMode}
              onFile={setPendingDesignContext}
              onText={setContextText}
            />
            {runs.length > 0 && (
              <div className="recent">
                <h3>Previous local runs</h3>
                {runs.map((run) => (
                  <button
                    key={run.runId}
                    onClick={() => {
                      setActiveId(run.runId);
                      setStep(stepFor(run));
                    }}
                  >
                    <span>{run.filename}</span>
                    <small>{run.phase}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {step === 'inputs' && workType === 'validate' && (
          <section className="panel form-panel" aria-labelledby="validate-input-title">
            <p className="eyebrow">Step 2 · Inputs</p>
            <h2 id="validate-input-title">Choose validation evidence</h2>
            <div className="input-file-grid single-reference">
              <DesignReferenceInput
                file={implementationDesignFile}
                busy={busy}
                maxBytes={session?.limits.maxUploadBytes}
                onFile={setImplementationDesignFile}
              />
            </div>
            <ContextInput
              mode={contextMode}
              file={pendingDesignContext}
              text={contextText}
              maxBytes={4_000}
              onMode={setContextMode}
              onFile={setPendingDesignContext}
              onText={setContextText}
            />
            <div className="sticky-actions">
              <button
                className="primary"
                disabled={!implementationDesignFile}
                onClick={() => setStep('boundaries')}
              >
                Continue to boundaries
              </button>
            </div>
          </section>
        )}

        {step === 'boundaries' && workType === 'generate' && active?.inspection && (
          <section className="panel" aria-labelledby="preferences-title">
            <div className="summary-strip">
              <div>
                <span>File</span>
                <strong>{active.inspection.filename}</strong>
              </div>
              <div>
                <span>Canvas</span>
                <strong>
                  {active.inspection.width} × {active.inspection.height}
                </strong>
              </div>
              <div>
                <span>Readable text</span>
                <strong>{active.inspection.readableTextNodes}</strong>
              </div>
              <div>
                <span>
                  {active.inspection.mediaType === 'image/png' ? 'Reference' : 'Sanitization'}
                </span>
                <strong className="good">
                  {active.inspection.mediaType === 'image/png' ? 'PNG verified' : 'Accepted'}
                </strong>
              </div>
            </div>
            {cleanupDecisions.length > 0 && (
              <div className="alert" role="status">
                <strong>Studio safely cleaned the uploaded SVG.</strong>
                <ul>
                  {cleanupDecisions.map((decision) => (
                    <li key={decision}>{decision}</li>
                  ))}
                </ul>
              </div>
            )}
            <details>
              <summary>Inspection evidence</summary>
              <dl className="hashes">
                <div>
                  <dt>Original</dt>
                  <dd>
                    <code>{shortHash(active.inspection.originalInputHash)}</code>
                  </dd>
                </div>
                <div>
                  <dt>Sanitized</dt>
                  <dd>
                    <code>{shortHash(active.inspection.sanitizedHash)}</code>
                  </dd>
                </div>
                <div>
                  <dt>Nodes</dt>
                  <dd>{active.inspection.sanitization.nodeCount}</dd>
                </div>
                <div>
                  <dt>Uncertainties</dt>
                  <dd>{active.inspection.uncertaintyCount}</dd>
                </div>
              </dl>
            </details>
            <p className="eyebrow">Step 3 · Preferences and boundaries</p>
            <h2 id="preferences-title">Set implementation preferences</h2>
            <DesignContextFileEditor
              context={active.designContext}
              maxBytes={session?.limits.maxDesignContextBytes}
              disabled={busy || !session}
              onFile={uploadDesignContext}
            />
            <fieldset>
              <legend>Generation engine</legend>
              <div className="choice-grid compact">
                <label className={engine === 'agent' ? 'choice selected' : 'choice'}>
                  <input
                    type="radio"
                    name="engine"
                    value="agent"
                    checked={engine === 'agent'}
                    disabled={!session?.agent.configured}
                    onChange={() => {
                      setEngine('agent');
                      setMode('semantic');
                    }}
                  />
                  <strong>AI agent (default)</strong>
                  <span>
                    The MCP-connected chat agent authors real HTML and CSS from the design evidence;
                    deterministic checks then render, measure, and verify it.
                  </span>
                </label>
                <label className={engine === 'deterministic' ? 'choice selected' : 'choice'}>
                  <input
                    type="radio"
                    name="engine"
                    value="deterministic"
                    checked={engine === 'deterministic'}
                    onChange={() => {
                      setEngine('deterministic');
                      setMode(active.inspection?.recommendedModes[0] ?? 'hybrid');
                    }}
                  />
                  <strong>Deterministic</strong>
                  <span>Built-in bounded generator; no model is involved.</span>
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Output mode</legend>
              <div className="choice-grid">
                {(['hybrid', 'semantic', 'exact'] as Mode[]).map((item) => (
                  <label className={mode === item ? 'choice selected' : 'choice'} key={item}>
                    <input
                      type="radio"
                      name="mode"
                      value={item}
                      checked={mode === item}
                      onChange={() => setMode(item)}
                    />
                    <strong>{title(item)}</strong>
                    <span>{modeHelp(item)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Layout intent</legend>
              <div className="choice-grid compact">
                {(['responsive', 'fixed', 'component'] as Layout[]).map((item) => (
                  <label className={layout === item ? 'choice selected' : 'choice'} key={item}>
                    <input
                      type="radio"
                      name="layout"
                      value={item}
                      checked={layout === item}
                      onChange={() => setLayout(item)}
                    />
                    <strong>{layoutTitle(item)}</strong>
                  </label>
                ))}
              </div>
            </fieldset>
            <CanvasEditor
              sourceWidth={active.inspection?.width ?? 1}
              sourceHeight={active.inspection?.height ?? 1}
              custom={customCanvas}
              width={canvasWidth}
              height={canvasHeight}
              dpr={canvasDpr}
              fit={fit}
              horizontalAlignment={horizontalAlignment}
              verticalAlignment={verticalAlignment}
              viewports={validationViewports}
              onCustom={setCustomCanvas}
              onWidth={setCanvasWidth}
              onHeight={setCanvasHeight}
              onDpr={setCanvasDpr}
              onFit={setFit}
              onHorizontalAlignment={setHorizontalAlignment}
              onVerticalAlignment={setVerticalAlignment}
              onViewports={setValidationViewports}
            />
            <StructuredContextEditor value={structuredContext} onChange={setStructuredContext} />
            <label className="note">
              <span>
                {engine === 'agent' ? 'Context for the AI agent' : 'Implementation note'}{' '}
                <small>optional, maximum 4,000 characters</small>
              </span>
              <textarea
                maxLength={4000}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder={
                  engine === 'agent'
                    ? 'Anything the agent should know: exact copy, interactions, breakpoints, brand rules, component semantics, content that is unreadable in the SVG…'
                    : 'Describe only evidence-backed intent that materially affects the output.'
                }
              />
              <small>{instructions.length} / 4,000</small>
            </label>
            {engine === 'agent' && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={improve}
                  onChange={(event) => setImprove(event.target.checked)}
                />
                <span>
                  Confirm each result before finishing{' '}
                  <small>
                    review the deterministic evidence, then accept it or ask the agent for up to{' '}
                    {session?.agent.maxImproveRounds ?? 5} improvement rounds
                  </small>
                </span>
              </label>
            )}
            <div className="actions">
              <button className="primary" disabled={busy} onClick={() => setStep('handoff')}>
                Continue to handoff
              </button>
            </div>
          </section>
        )}

        {step === 'boundaries' && workType === 'validate' && (
          <section className="panel form-panel" aria-labelledby="validate-boundaries-title">
            <p className="eyebrow">Step 3 · Preferences and boundaries</p>
            <h2 id="validate-boundaries-title">Set the exact implementation boundary</h2>
            <BoundarySummary target={session?.handoff.targetRoot ?? null} />
            <label className="field-block">
              <span>
                Already-running route <small>required</small>
              </span>
              <input
                type="url"
                value={implementationRoute}
                onChange={(event) => setImplementationRoute(event.target.value)}
              />
            </label>
            <label className="field-block">
              <span>
                Exact writable files <small>required · one target-relative file per line</small>
              </span>
              <textarea
                value={implementationWrites}
                onChange={(event) => setImplementationWrites(event.target.value)}
              />
            </label>
            <label className="field-block">
              <span>
                Presentation matrix file <small>optional · target-relative JSON</small>
              </span>
              <input
                value={implementationPresentationPath}
                onChange={(event) => setImplementationPresentationPath(event.target.value)}
                placeholder="smart-ui.presentation.json"
              />
            </label>
            <p className="field-help">
              Viewports come from the optional presentation file and configured target viewports;
              interaction states remain governed by the target Smart UI configuration.
            </p>
            <div className="sticky-actions">
              <button
                className="primary"
                disabled={busy || !implementationRoute.trim() || !implementationWrites.trim()}
                onClick={() => void prepareImplementationHandoff()}
              >
                Prepare bounded task
              </button>
            </div>
          </section>
        )}

        {step === 'handoff' && workType === 'generate' && active?.phase === 'inspected' && (
          <section className="panel handoff-panel" aria-labelledby="generation-handoff-title">
            <p className="eyebrow">Step 4 · Handoff</p>
            <h2 id="generation-handoff-title">Choose how to continue</h2>
            <p className="lede">Both methods use this run and converge on deterministic review.</p>
            <div className="continuation-grid">
              <article>
                <small>Connected</small>
                <h3>Connected MCP agent</h3>
                <p>Author through the configured MCP agent and keep this tab open for progress.</p>
                <button className="primary" disabled={busy} onClick={() => void generate()}>
                  {engine === 'agent' ? 'Continue with MCP agent' : 'Run deterministic generator'}
                </button>
              </article>
              <article>
                <small>Portable</small>
                <h3>External agent or human</h3>
                <p>
                  Create a persistent task with bounded evidence, instructions, and review commands.
                </p>
                <button disabled={busy} onClick={() => void prepareHandoff()}>
                  Prepare external handoff
                </button>
              </article>
            </div>
          </section>
        )}

        {step === 'handoff' && activeTask && (
          <TaskHandoff task={activeTask} onReview={() => setStep('review')} />
        )}

        {step === 'handoff' && workType === 'generate' && active && isRunning(active.phase) && (
          <section className="panel progress-panel" aria-labelledby="generate-title">
            <p className="eyebrow">Step 4 · Handoff</p>
            <h2 id="generate-title">Building and measuring</h2>
            <div
              className="progress-ring"
              style={
                {
                  '--progress': `${Math.round(active.progress.value * 360)}deg`,
                } as React.CSSProperties
              }
            >
              <span>{Math.round(active.progress.value * 100)}%</span>
            </div>
            <p className="stage" aria-live="polite">
              <strong>{title(active.progress.stage)}</strong>
              <br />
              {active.progress.message}
            </p>
            {(active.phase === 'awaiting-agent' || active.phase === 'awaiting-agent-revision') && (
              <div className="agent-waiting">
                <p>
                  Paste this into the chat connected to the <code>smart-ui</code> MCP server, then
                  keep this tab open while the agent authors
                  {active.pendingAuthoring && active.pendingAuthoring.round > 1
                    ? ` improvement round ${active.pendingAuthoring.round}`
                    : ' the design'}
                  :
                </p>
                <code>
                  {`Use the smart-ui MCP server. Call list_studio_authoring_requests with studioWorkspace "${session?.agent.workspace ?? ''}", look at the attached rendered design and prior-round images, author complete offline index.html and styles.css for run ${active.runId} round ${active.pendingAuthoring?.round ?? 1} (no scripts, no external URLs), then call submit_studio_authored_html with approved: true and that exact runId and round.`}
                </code>
                {active.pendingAuthoring?.feedback && (
                  <p className="feedback-echo">
                    Feedback sent with this round: {active.pendingAuthoring.feedback}
                  </p>
                )}
              </div>
            )}
            <ol className="stage-list">
              {[
                ...(engine === 'agent' ? ['agent'] : []),
                'sanitize',
                'inspect',
                'generate',
                'preview',
                'compare',
                'package',
                'report',
              ].map((item) => (
                <li key={item} className={stageReached(item, active.progress.stage) ? 'done' : ''}>
                  {item === 'agent' ? 'AI agent' : title(item)}
                </li>
              ))}
            </ol>
            {isRunning(active.phase) && (
              <button className="danger" onClick={() => void cancel()}>
                Cancel generation
              </button>
            )}
          </section>
        )}

        {step === 'review' && workType === 'generate' && active && !activeTask && (
          <Review
            run={active}
            source={source}
            feedback={feedback}
            busy={busy}
            onFeedback={setFeedback}
            onDecide={decide}
            onSource={openSource}
            onDelete={removeRun}
          />
        )}
        {step === 'review' && activeTask && (
          <TaskReview
            task={activeTask}
            busy={busy}
            onAccept={() => void decideTask(activeTask, 'accept')}
            onRevise={() => setStep('handoff')}
            onCancel={() => void decideTask(activeTask, 'cancel')}
            onRemove={() => void unregisterTask(activeTask)}
          />
        )}
      </main>
      <footer>
        Runs remain plaintext in the dedicated local workspace until deleted or expired.
      </footer>
    </div>
  );
}

export function DesignReferenceInput({
  file,
  busy,
  maxBytes,
  inputRef,
  onFile,
}: {
  file?: File | undefined;
  busy: boolean;
  maxBytes?: number | undefined;
  inputRef?: React.RefObject<HTMLInputElement | null> | undefined;
  onFile(file: File): void;
}): ReactNode {
  return (
    <label
      className="dropzone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const dropped = event.dataTransfer.files[0];
        if (dropped) onFile(dropped);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/svg+xml,image/png,.svg,.png"
        disabled={busy || maxBytes === undefined}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) onFile(selected);
        }}
      />
      <small>Required</small>
      <strong>
        {busy ? 'Inspecting safely…' : (file?.name ?? 'Choose or drop an SVG or PNG')}
      </strong>
      <span>Maximum {maxBytes ? formatBytes(maxBytes) : 'loading…'}</span>
    </label>
  );
}

function ContextInput({
  mode,
  file,
  text,
  maxBytes,
  onMode,
  onFile,
  onText,
}: {
  mode: ContextMode;
  file: File | undefined;
  text: string;
  maxBytes: number | undefined;
  onMode(value: ContextMode): void;
  onFile(value: File | undefined): void;
  onText(value: string): void;
}): ReactNode {
  return (
    <fieldset className="context-input">
      <legend>
        Design context <small>optional</small>
      </legend>
      <div className="segmented" aria-label="Design context source">
        <button
          type="button"
          className={mode === 'upload' ? 'active' : ''}
          onClick={() => onMode('upload')}
        >
          Upload
        </button>
        <button
          type="button"
          className={mode === 'paste' ? 'active' : ''}
          onClick={() => onMode('paste')}
        >
          Paste or type
        </button>
      </div>
      {mode === 'upload' ? (
        <label
          className="dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            onFile(event.dataTransfer.files[0]);
          }}
        >
          <input type="file" onChange={(event) => onFile(event.target.files?.[0])} />
          <small>Optional</small>
          <strong>{file?.name ?? 'Choose or drop design context'}</strong>
          <span>UTF-8 text file · maximum {maxBytes ? formatBytes(maxBytes) : 'loading…'}</span>
        </label>
      ) : (
        <label className="field-block">
          <span>
            Context <small>{text.length} characters</small>
          </span>
          <textarea
            value={text}
            maxLength={maxBytes}
            onChange={(event) => onText(event.target.value)}
            placeholder="Exact copy, components, interactions, tokens, or implementation constraints"
          />
        </label>
      )}
    </fieldset>
  );
}

function BoundarySummary({ target }: { target: string | null }): ReactNode {
  return (
    <div className="boundary-summary">
      <span>Configured target</span>
      <code>{target ?? 'No target configured'}</code>
      <small>Read-only here. Every writable path is revalidated by the server.</small>
    </div>
  );
}

export function connectedHandoffInstructions(task: HandoffTaskView): string {
  const files = task.writableFiles.map((file) => `- ${file}`).join('\n');
  return [
    `Complete validate-UI task ${task.taskId}.`,
    '',
    `Task file: ${task.taskFile}`,
    `Task hash: ${task.taskHash}`,
    `Revision: ${task.revision}`,
    'Exact writable files (target-relative):',
    files || '- None',
    '',
    '1. Call get_handoff_task with the task file above and verify its hash and revision.',
    '2. Read every declared evidence file needed for the implementation with read_handoff_evidence.',
    '3. Inspect the current contents of every writable file listed above and implement the task. Do not modify or submit any other path.',
    '4. Call submit_handoff_implementation with approved=true, the task file, task hash, revision, authoringAgent, and the full UTF-8 content of every writable file listed above.',
    '5. Report the resulting attempt number, scores, blocking findings, and report path.',
  ].join('\n');
}

export function portableHandoffInstructions(task: HandoffTaskView): string {
  const files = task.writableFiles.map((file) => `- ${file}`).join('\n');
  return [
    `Complete validate-UI task ${task.taskId}.`,
    '',
    `Task file: ${task.taskFile}`,
    `Task hash: ${task.taskHash}`,
    `Revision: ${task.revision}`,
    ...(task.route ? [`Running route: ${task.route}`] : []),
    'Exact writable files (target-relative):',
    files || '- None',
    '',
    '1. Open task.json and read its instructions, design evidence, repository summary, matrix, decisions, and uncertainties.',
    '2. Resolve the target root from task.json, inspect the current contents of every writable file above, and implement the task.',
    '3. Do not modify or submit any other path.',
    '4. Run this review command:',
    task.commands.review,
    '5. Inspect the reported attempt and resolve blocking findings only within the same writable files.',
  ].join('\n');
}

export function TaskHandoff({
  task,
  onReview,
}: {
  task: HandoffTaskView;
  onReview(): void;
}): ReactNode {
  return (
    <section className="panel handoff-panel" aria-labelledby="task-handoff-title">
      <p className="eyebrow">Step 4 · Handoff</p>
      <div className="review-header">
        <div>
          <h2 id="task-handoff-title">Choose how to continue</h2>
          <p className="lede">
            Task {task.taskId} is persistent and both methods converge on the same review.
          </p>
        </div>
        <span className="status-pill">{task.status}</span>
      </div>
      <div className="continuation-grid">
        <article>
          <small>Connected</small>
          <h3>Connected MCP agent</h3>
          <p>Copy one complete prompt with the task identity, files, and exact MCP calls.</p>
          <CommandBlock value={connectedHandoffInstructions(task)} label="Agent prompt" />
        </article>
        <article>
          <small>Portable</small>
          <h3>External agent or human</h3>
          <p>Copy one complete checklist with the task identity, files, and review command.</p>
          <CommandBlock
            value={portableHandoffInstructions(task)}
            label="Implementation checklist"
          />
        </article>
      </div>
      <div className="boundary-summary">
        <span>Exact writable files</span>
        <code>
          {task.writableFiles.length ? task.writableFiles.join('\n') : 'Standalone bundle only'}
        </code>
        {task.route && <small>Running route: {task.route}</small>}
      </div>
      <div className="sticky-actions">
        <button className="primary" disabled={!task.attempt} onClick={onReview}>
          {task.attempt ? `Review attempt ${task.attempt.number}` : 'Waiting for first attempt'}
        </button>
      </div>
    </section>
  );
}

function CommandBlock({ value, label }: { value: string; label: string }): ReactNode {
  return (
    <div className="command-block">
      <span>{label}</span>
      <pre>
        <code>{value}</code>
      </pre>
      <button type="button" onClick={() => void navigator.clipboard.writeText(value)}>
        Copy
      </button>
    </div>
  );
}

function TaskReview({
  task,
  busy,
  onAccept,
  onRevise,
  onCancel,
  onRemove,
}: {
  task: HandoffTaskView;
  busy: boolean;
  onAccept(): void;
  onRevise(): void;
  onCancel(): void;
  onRemove(): void;
}): ReactNode {
  const attempt = task.attempt;
  return (
    <section className="review task-review-screen" aria-labelledby="task-review-title">
      <div className="review-header">
        <div>
          <p className="eyebrow">Step 5 · Review</p>
          <h2 id="task-review-title">Review verified attempt</h2>
          <p>
            {task.taskId} · revision {task.revision}
          </p>
        </div>
        <span className="status-pill">{task.status}</span>
      </div>
      {!attempt ? (
        <div className="panel">
          <h3>No verified attempt yet</h3>
          <p className="muted">
            Continue from Handoff after the implementation is ready for deterministic review.
          </p>
        </div>
      ) : (
        <>
          <div className="metrics">
            <Metric label="Attempt" value={String(attempt.number)} />
            <Metric label="Outcome" value={attempt.outcome} />
            <Metric label="Findings" value={String(attempt.findingCount)} />
            <Metric label="Blocking" value={String(attempt.blockingFindingCount)} />
          </div>
          {attempt.generation && (
            <div className="panel inset">
              <h3>Generation fidelity</h3>
              <p className="score-value">
                {attempt.generation.visualSimilarityPercent === null
                  ? 'Not scored'
                  : `${attempt.generation.visualSimilarityPercent.toFixed(3)}%`}
              </p>
              {attempt.generation.reportPath && <code>{attempt.generation.reportPath}</code>}
            </div>
          )}
          {attempt.implementation && (
            <div className="review-grid">
              <div className="panel inset">
                <h3>Viewport and state evidence</h3>
                <div className="cell-grid">
                  {attempt.implementation.cells.map((cell) => (
                    <div className="evidence-cell" key={`${cell.viewport}-${cell.state}`}>
                      <strong>
                        {cell.viewport} · {cell.state}
                      </strong>
                      <span>{cell.classification}</span>
                      <small>
                        {cell.score === null
                          ? 'Not scored · robustness only'
                          : `${cell.score.toFixed(3)}% fidelity`}
                      </small>
                    </div>
                  ))}
                </div>
              </div>
              <div className="panel inset">
                <h3>Changed allowlisted files</h3>
                {attempt.implementation.changedFiles.length ? (
                  attempt.implementation.changedFiles.map((file) => (
                    <code className="path-row" key={file}>
                      {file}
                    </code>
                  ))
                ) : (
                  <p className="muted">No changed files reported.</p>
                )}
              </div>
            </div>
          )}
          {attempt.revisionGuidance.length > 0 && (
            <div className="panel inset">
              <h3>Revision guidance</h3>
              <ul>
                {attempt.revisionGuidance.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="decision-bar">
        <button
          className="primary"
          disabled={busy || !attempt || task.status !== 'awaiting-decision'}
          onClick={onAccept}
        >
          Accept
        </button>
        <button
          disabled={busy || ['accepted', 'canceled'].includes(task.status)}
          onClick={onRevise}
        >
          Revise
        </button>
        <button
          className="danger"
          disabled={busy || ['accepted', 'canceled'].includes(task.status)}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button disabled={busy} onClick={onRemove}>
          Remove from Studio
        </button>
        <small>
          Removal unregisters this task from Studio; task and repository files remain intact.
        </small>
      </div>
    </section>
  );
}

export function DesignContextFileEditor({
  context,
  maxBytes,
  disabled,
  onFile,
}: {
  context: RunSummary['designContext'];
  maxBytes?: number | undefined;
  disabled: boolean;
  onFile(file: File): void | Promise<void>;
}): ReactNode {
  const [mode, setMode] = useState<ContextMode>('upload');
  const [text, setText] = useState('');

  return (
    <fieldset className="editor-section">
      <legend>
        Design context file <small>optional</small>
      </legend>
      <p className="field-help">
        Add the JSX, TSX, HTML, CSS, JSON, Markdown, or other UTF-8 text file supplied with the
        design. The connected agent receives this file together with the SVG or PNG evidence.
      </p>
      <div className="segmented" aria-label="Boundaries design context source">
        <button
          type="button"
          className={mode === 'upload' ? 'active' : ''}
          onClick={() => setMode('upload')}
        >
          Upload
        </button>
        <button
          type="button"
          className={mode === 'paste' ? 'active' : ''}
          onClick={() => setMode('paste')}
        >
          Paste or type
        </button>
      </div>
      {mode === 'upload' ? (
        <label
          className="dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file && !disabled) void onFile(file);
          }}
        >
          <input
            type="file"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onFile(file);
            }}
          />
          <small>Optional</small>
          <strong>{context?.filename ?? 'Choose or drop design context'}</strong>
          <span>UTF-8 text file · maximum {maxBytes ? formatBytes(maxBytes) : 'loading…'}</span>
        </label>
      ) : (
        <div className="field-block">
          <label htmlFor="boundaries-design-context">
            Context <small>{text.length} characters</small>
          </label>
          <textarea
            id="boundaries-design-context"
            value={text}
            maxLength={maxBytes}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            placeholder="Exact copy, components, interactions, tokens, or implementation constraints"
          />
          <button
            type="button"
            className="primary"
            disabled={disabled || !text.trim()}
            onClick={() =>
              void onFile(new File([text], 'pasted-design-context.txt', { type: 'text/plain' }))
            }
          >
            Attach pasted context
          </button>
        </div>
      )}
      {context && (
        <div className="context-file-summary" role="status">
          <strong>{context.filename}</strong>
          <span>
            {formatBytes(context.byteLength)} · {shortHash(context.originalHash)}
          </span>
        </div>
      )}
    </fieldset>
  );
}

export function CanvasEditor({
  sourceWidth,
  sourceHeight,
  custom,
  width,
  height,
  dpr,
  fit,
  horizontalAlignment,
  verticalAlignment,
  viewports,
  onCustom,
  onWidth,
  onHeight,
  onDpr,
  onFit,
  onHorizontalAlignment,
  onVerticalAlignment,
  onViewports,
}: {
  sourceWidth: number;
  sourceHeight: number;
  custom: boolean;
  width: number;
  height: number;
  dpr: number;
  fit: Fit;
  horizontalAlignment: Alignment;
  verticalAlignment: Alignment;
  viewports: PresentationSpec['viewports'];
  onCustom(value: boolean): void;
  onWidth(value: number): void;
  onHeight(value: number): void;
  onDpr(value: number): void;
  onFit(value: Fit): void;
  onHorizontalAlignment(value: Alignment): void;
  onVerticalAlignment(value: Alignment): void;
  onViewports(value: PresentationSpec['viewports']): void;
}): ReactNode {
  const changeViewport = (index: number, patch: Partial<PresentationSpec['viewports'][number]>) =>
    onViewports(
      viewports.map((viewport, itemIndex) =>
        itemIndex === index ? { ...viewport, ...patch } : viewport,
      ),
    );
  return (
    <fieldset className="editor-section">
      <legend>Presentation canvas</legend>
      <p className="field-help">
        Source dimensions remain {sourceWidth} × {sourceHeight}. Choose the exact CSS-pixel canvas
        used for reference and output evidence.
      </p>
      <div className="choice-grid compact">
        <label className={!custom ? 'choice selected' : 'choice'}>
          <input
            type="radio"
            name="canvas-mode"
            checked={!custom}
            onChange={() => onCustom(false)}
          />
          <strong>Intrinsic</strong>
          <span>Use the source canvas without scaling.</span>
        </label>
        <label className={custom ? 'choice selected' : 'choice'}>
          <input type="radio" name="canvas-mode" checked={custom} onChange={() => onCustom(true)} />
          <strong>Custom</strong>
          <span>Set explicit size, DPR, fit, and alignment.</span>
        </label>
      </div>
      <div className="field-grid">
        <LabeledNumber
          label="Primary canvas width"
          value={custom ? width : sourceWidth}
          disabled={!custom}
          min={1}
          max={10000}
          onChange={onWidth}
        />
        <LabeledNumber
          label="Primary canvas height"
          value={custom ? height : sourceHeight}
          disabled={!custom}
          min={1}
          max={10000}
          onChange={onHeight}
        />
        <LabeledNumber
          label="Device pixel ratio"
          value={dpr}
          min={0.25}
          max={4}
          step={0.25}
          onChange={onDpr}
        />
        <label>
          <span>Fit</span>
          <select
            value={custom ? fit : 'intrinsic'}
            disabled={!custom}
            onChange={(event) => onFit(event.target.value as Fit)}
          >
            {(['intrinsic', 'contain', 'cover', 'stretch'] as Fit[]).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Horizontal alignment</span>
          <select
            value={custom ? horizontalAlignment : 'start'}
            disabled={!custom}
            onChange={(event) => onHorizontalAlignment(event.target.value as Alignment)}
          >
            {(['start', 'center', 'end'] as Alignment[]).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Vertical alignment</span>
          <select
            value={custom ? verticalAlignment : 'start'}
            disabled={!custom}
            onChange={(event) => onVerticalAlignment(event.target.value as Alignment)}
          >
            {(['start', 'center', 'end'] as Alignment[]).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="editor-heading">
        <strong>Named validation viewports</strong>
        <button
          type="button"
          disabled={viewports.length >= 8}
          onClick={() =>
            onViewports([
              ...viewports,
              {
                id: `viewport-${viewports.length + 1}`,
                width: 375,
                height: 667,
                deviceScaleFactor: 1,
                requirement: 'advisory',
              },
            ])
          }
        >
          Add viewport
        </button>
      </div>
      {viewports.map((viewport, index) => (
        <div className="editor-row" key={`${viewport.id}-${index}`}>
          <label>
            <span>Viewport ID</span>
            <input
              maxLength={100}
              value={viewport.id}
              onChange={(event) => changeViewport(index, { id: event.target.value })}
            />
          </label>
          <LabeledNumber
            label="Width"
            value={viewport.width}
            min={1}
            max={10000}
            onChange={(value) => changeViewport(index, { width: value })}
          />
          <LabeledNumber
            label="Height"
            value={viewport.height}
            min={1}
            max={10000}
            onChange={(value) => changeViewport(index, { height: value })}
          />
          <LabeledNumber
            label="DPR"
            value={viewport.deviceScaleFactor}
            min={0.25}
            max={4}
            step={0.25}
            onChange={(value) => changeViewport(index, { deviceScaleFactor: value })}
          />
          <label>
            <span>Acceptance</span>
            <select
              value={viewport.requirement}
              onChange={(event) =>
                changeViewport(index, {
                  requirement: event.target.value as 'required' | 'advisory',
                })
              }
            >
              <option value="required">required</option>
              <option value="advisory">advisory</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => onViewports(viewports.filter((_, itemIndex) => itemIndex !== index))}
          >
            Remove
          </button>
        </div>
      ))}
    </fieldset>
  );
}

export function StructuredContextEditor({
  value,
  onChange,
}: {
  value: StructuredDesignContext;
  onChange(value: StructuredDesignContext): void;
}): ReactNode {
  return (
    <fieldset className="editor-section">
      <legend>Structured design context</legend>
      <p className="field-help">
        Typed evidence is bounded, persisted with provenance, and treated as untrusted content.
      </p>
      <ContextGroup
        title="Exact copy"
        addLabel="Add copy"
        onAdd={() =>
          onChange({
            ...value,
            exactCopy: [
              ...value.exactCopy,
              {
                id: `copy-${value.exactCopy.length + 1}`,
                label: '',
                text: '',
                sourceNodeIds: [],
                provenance: 'studio:user',
              },
            ],
          })
        }
      >
        {value.exactCopy.map((item, index) => (
          <div className="editor-row" key={`${item.id}-${index}`}>
            <TextField
              label="Copy ID"
              value={item.id}
              onChange={(text) =>
                onChange({ ...value, exactCopy: updateAt(value.exactCopy, index, { id: text }) })
              }
            />
            <TextField
              label="Label"
              value={item.label}
              onChange={(text) =>
                onChange({ ...value, exactCopy: updateAt(value.exactCopy, index, { label: text }) })
              }
            />
            <TextField
              label="Exact text"
              value={item.text}
              onChange={(text) =>
                onChange({ ...value, exactCopy: updateAt(value.exactCopy, index, { text }) })
              }
            />
            <TextField
              label="Locale"
              value={item.locale ?? ''}
              onChange={(text) => {
                const withoutLocale = { ...item };
                delete withoutLocale.locale;
                onChange({
                  ...value,
                  exactCopy: value.exactCopy.map((entry, itemIndex) =>
                    itemIndex === index
                      ? text
                        ? { ...withoutLocale, locale: text }
                        : withoutLocale
                      : entry,
                  ),
                });
              }}
            />
            <TextField
              label="Source node IDs (comma separated)"
              value={item.sourceNodeIds.join(', ')}
              onChange={(text) =>
                onChange({
                  ...value,
                  exactCopy: updateAt(value.exactCopy, index, {
                    sourceNodeIds: parseSourceNodeIds(text),
                  }),
                })
              }
            />
            <RemoveButton
              onClick={() => onChange({ ...value, exactCopy: removeAt(value.exactCopy, index) })}
            />
          </div>
        ))}
      </ContextGroup>
      <ContextGroup
        title="Design tokens"
        addLabel="Add token"
        onAdd={() =>
          onChange({
            ...value,
            designTokens: [
              ...value.designTokens,
              {
                name: `token-${value.designTokens.length + 1}`,
                kind: 'color',
                value: '',
                provenance: 'studio:user',
              },
            ],
          })
        }
      >
        {value.designTokens.map((item, index) => (
          <div className="editor-row" key={`${item.name}-${index}`}>
            <TextField
              label="Token name"
              value={item.name}
              onChange={(text) =>
                onChange({
                  ...value,
                  designTokens: updateAt(value.designTokens, index, { name: text }),
                })
              }
            />
            <label>
              <span>Token kind</span>
              <select
                value={item.kind}
                onChange={(event) =>
                  onChange({
                    ...value,
                    designTokens: updateAt(value.designTokens, index, {
                      kind: event.target.value as typeof item.kind,
                    }),
                  })
                }
              >
                {['color', 'typography', 'spacing', 'radius', 'border', 'shadow', 'other'].map(
                  (kind) => (
                    <option key={kind}>{kind}</option>
                  ),
                )}
              </select>
            </label>
            <TextField
              label="Token value"
              value={item.value}
              onChange={(text) =>
                onChange({
                  ...value,
                  designTokens: updateAt(value.designTokens, index, { value: text }),
                })
              }
            />
            <TextField
              label="Usage"
              value={item.usage ?? ''}
              onChange={(text) =>
                onChange({
                  ...value,
                  designTokens: updateAt(value.designTokens, index, { usage: text }),
                })
              }
            />
            <RemoveButton
              onClick={() =>
                onChange({ ...value, designTokens: removeAt(value.designTokens, index) })
              }
            />
          </div>
        ))}
      </ContextGroup>
      <ContextGroup
        title="Component semantics"
        addLabel="Add component"
        onAdd={() =>
          onChange({
            ...value,
            componentSemantics: [
              ...value.componentSemantics,
              {
                id: `component-${value.componentSemantics.length + 1}`,
                name: '',
                role: '',
                sourceNodeIds: [],
                provenance: 'studio:user',
              },
            ],
          })
        }
      >
        {value.componentSemantics.map((item, index) => (
          <div className="editor-row" key={`${item.id}-${index}`}>
            <TextField
              label="Component ID"
              value={item.id}
              onChange={(text) =>
                onChange({
                  ...value,
                  componentSemantics: updateAt(value.componentSemantics, index, { id: text }),
                })
              }
            />
            <TextField
              label="Component name"
              value={item.name}
              onChange={(text) =>
                onChange({
                  ...value,
                  componentSemantics: updateAt(value.componentSemantics, index, { name: text }),
                })
              }
            />
            <TextField
              label="ARIA or semantic role"
              value={item.role}
              onChange={(text) =>
                onChange({
                  ...value,
                  componentSemantics: updateAt(value.componentSemantics, index, { role: text }),
                })
              }
            />
            <TextField
              label="State or variant"
              value={item.stateOrVariant ?? ''}
              onChange={(text) =>
                onChange({
                  ...value,
                  componentSemantics: updateAt(value.componentSemantics, index, {
                    stateOrVariant: text,
                  }),
                })
              }
            />
            <TextField
              label="Source node IDs (comma separated)"
              value={item.sourceNodeIds.join(', ')}
              onChange={(text) =>
                onChange({
                  ...value,
                  componentSemantics: updateAt(value.componentSemantics, index, {
                    sourceNodeIds: parseSourceNodeIds(text),
                  }),
                })
              }
            />
            <RemoveButton
              onClick={() =>
                onChange({
                  ...value,
                  componentSemantics: removeAt(value.componentSemantics, index),
                })
              }
            />
          </div>
        ))}
      </ContextGroup>
      <ContextGroup
        title="Interactions"
        addLabel="Add interaction"
        onAdd={() =>
          onChange({
            ...value,
            interactions: [
              ...value.interactions,
              {
                id: `interaction-${value.interactions.length + 1}`,
                trigger: '',
                target: '',
                resultingBehavior: '',
                sourceNodeIds: [],
                provenance: 'studio:user',
              },
            ],
          })
        }
      >
        {value.interactions.map((item, index) => (
          <div className="editor-row" key={`${item.id}-${index}`}>
            <TextField
              label="Interaction ID"
              value={item.id}
              onChange={(text) =>
                onChange({
                  ...value,
                  interactions: updateAt(value.interactions, index, { id: text }),
                })
              }
            />
            <TextField
              label="Trigger"
              value={item.trigger}
              onChange={(text) =>
                onChange({
                  ...value,
                  interactions: updateAt(value.interactions, index, { trigger: text }),
                })
              }
            />
            <TextField
              label="Target"
              value={item.target}
              onChange={(text) =>
                onChange({
                  ...value,
                  interactions: updateAt(value.interactions, index, { target: text }),
                })
              }
            />
            <TextField
              label="Resulting behavior or state"
              value={item.resultingBehavior}
              onChange={(text) =>
                onChange({
                  ...value,
                  interactions: updateAt(value.interactions, index, { resultingBehavior: text }),
                })
              }
            />
            <TextField
              label="Keyboard notes"
              value={item.keyboardNotes ?? ''}
              onChange={(text) =>
                onChange({
                  ...value,
                  interactions: updateAt(value.interactions, index, {
                    keyboardNotes: text,
                  }),
                })
              }
            />
            <TextField
              label="Source node IDs (comma separated)"
              value={item.sourceNodeIds.join(', ')}
              onChange={(text) =>
                onChange({
                  ...value,
                  interactions: updateAt(value.interactions, index, {
                    sourceNodeIds: parseSourceNodeIds(text),
                  }),
                })
              }
            />
            <RemoveButton
              onClick={() =>
                onChange({ ...value, interactions: removeAt(value.interactions, index) })
              }
            />
          </div>
        ))}
      </ContextGroup>
    </fieldset>
  );
}

function ContextGroup({
  title: groupTitle,
  addLabel,
  onAdd,
  children,
}: {
  title: string;
  addLabel: string;
  onAdd(): void;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="context-group" aria-label={groupTitle}>
      <div className="editor-heading">
        <strong>{groupTitle}</strong>
        <button type="button" onClick={onAdd}>
          {addLabel}
        </button>
      </div>
      {children}
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}): ReactNode {
  return (
    <label>
      <span>{label}</span>
      <input value={value} maxLength={4000} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function LabeledNumber({
  label,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange(value: number): void;
}): ReactNode {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function RemoveButton({ onClick }: { onClick(): void }): ReactNode {
  return (
    <button type="button" onClick={onClick}>
      Remove
    </button>
  );
}

function parseSourceNodeIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 100);
}

function updateAt<T>(items: T[], index: number, patch: Partial<T>): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item));
}

function removeAt<T>(items: T[], index: number): T[] {
  return items.filter((_, itemIndex) => itemIndex !== index);
}

export function Review({
  run,
  source,
  feedback,
  busy,
  onFeedback,
  onDecide,
  onSource,
  onDelete,
}: {
  run: RunSummary;
  source: SourceFile | undefined;
  feedback: string;
  busy: boolean;
  onFeedback(value: string): void;
  onDecide(action: 'accept' | 'improve', round?: number): Promise<void>;
  onSource(index: number): Promise<void>;
  onDelete(): Promise<void>;
}): ReactNode {
  const result = run.generation;
  if (run.phase === 'canceled' || !result) {
    return (
      <section className="panel">
        <p className="eyebrow">Step 5 · Review</p>
        <h2>{run.phase === 'canceled' ? 'Generation canceled' : 'Generation did not complete'}</h2>
        <p>{run.error?.message ?? run.progress.message}</p>
        {run.error?.recovery && <p>{run.error.recovery}</p>}
      </section>
    );
  }
  const evaluationFailure =
    run.error?.message ??
    result.failures[0]?.message ??
    (run.phase === 'failed' ? run.progress.message : undefined);
  return (
    <section className="review" aria-labelledby="review-title">
      {evaluationFailure && (
        <div className="alert" role="alert">
          <strong>This round could not be scored.</strong>
          <p>{evaluationFailure}</p>
          {run.error?.recovery && <p>{run.error.recovery}</p>}
        </div>
      )}
      <div className="review-header">
        <div>
          <p className="eyebrow">Step 5 · Review</p>
          <h2 id="review-title">Review deterministic evidence</h2>
          <p>
            {run.filename} · {result.requestedMode}
            {result.finalMode && result.finalMode !== result.requestedMode
              ? ` → ${result.finalMode}`
              : ''}
          </p>
          <p
            className={
              result.engine === 'agent' && result.agent?.accepted
                ? 'engine-note good'
                : 'engine-note'
            }
          >
            {result.engine === 'agent'
              ? result.agent?.accepted
                ? `Authored by the AI agent (${result.agent.host}) and verified against the design.`
                : `The AI agent proposal was not retained — showing the deterministic fallback. (${result.stoppedReason})`
              : 'Generated by the deterministic engine.'}
          </p>
        </div>
        <div className="actions">
          {result.downloads.archive && (
            <a className="button primary" href={result.downloads.archive}>
              Download ZIP
            </a>
          )}
          {result.downloads.report && (
            <a className="button" href={result.downloads.report}>
              Download report
            </a>
          )}
        </div>
      </div>
      <div className="metrics">
        <Metric
          label="Source visual similarity"
          value={
            result.visualSimilarity === null
              ? run.phase === 'failed'
                ? 'Unavailable — generation failed'
                : 'Not scored'
              : `${result.visualSimilarity.toFixed(3)}%`
          }
        />
        <Metric
          label="Visual mismatch"
          value={
            result.visualMismatchPercent === null
              ? run.phase === 'failed'
                ? 'Unavailable — generation failed'
                : 'Not scored'
              : `${result.visualMismatchPercent.toFixed(3)}%`
          }
        />
        <Metric label="Uncertainties" value={String(result.uncertaintyCount)} />
        <Metric label="Final mode" value={result.finalMode ?? result.requestedMode} />
      </div>
      {run.rounds.length > 1 && (
        <div className="panel inset rounds">
          <h3>Authoring rounds</h3>
          {run.rounds.map((item) => (
            <div
              className={item.round === run.selectedRound ? 'finding current' : 'finding'}
              key={item.round}
            >
              <strong>
                Round {item.round}
                {item.accepted ? ' · accepted' : item.round === run.selectedRound ? ' · shown' : ''}
              </strong>
              <span>
                {item.visualSimilarity === null
                  ? item.round === run.selectedRound && run.phase === 'failed'
                    ? 'Scoring failed'
                    : 'Not scored'
                  : `${item.visualSimilarity.toFixed(3)}% similarity`}
              </span>
              <small>
                {item.authoringAgent ?? 'deterministic engine'}
                {item.feedback ? ` · asked for: ${item.feedback}` : ''}
              </small>
              {run.decision && item.round !== run.selectedRound && (
                <button disabled={busy} onClick={() => void onDecide('accept', item.round)}>
                  Accept round {item.round}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {run.decision && (
        <div className="panel inset decision">
          <h3>Accept this result, or ask for an improvement</h3>
          {run.error && <p className="engine-note">{run.error.message}</p>}
          <p>
            Round {run.selectedRound} is measured above. Accepting keeps it as the run result;
            improving sends your feedback and these deterministic deltas to the connected agent for
            one more authored round.
          </p>
          <label className="note">
            <span>
              What should the agent improve? <small>optional, maximum 4,000 characters</small>
            </span>
            <textarea
              maxLength={4000}
              value={feedback}
              disabled={busy || !run.decision.canImprove}
              onChange={(event) => onFeedback(event.target.value)}
              placeholder="Name the concrete differences to fix: spacing, colors, type scale, missing content, alignment."
            />
            <small>{feedback.length} / 4,000</small>
          </label>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => void onDecide('accept')}>
              Accept round {run.selectedRound}
            </button>
            <button
              disabled={busy || !run.decision.canImprove}
              onClick={() => void onDecide('improve')}
            >
              Ask the agent to improve
            </button>
          </div>
          <small>
            {run.decision.canImprove
              ? `${run.decision.remainingImproveRounds} improvement round(s) remain.`
              : 'The improvement round bound was reached; accept the round you prefer.'}
          </small>
        </div>
      )}
      {result.previewUrl && (
        <div className="preview-card">
          <div className="card-title">
            <h3>Isolated generated preview</h3>
            <a href={result.previewUrl} target="_blank" rel="noreferrer">
              Open separately
            </a>
          </div>
          <iframe title="Generated output preview" sandbox="" src={result.previewUrl} />
        </div>
      )}
      {result.evidence && (
        <div className="evidence-grid">
          <Evidence label="Supplied design" src={result.evidence.design} />
          <Evidence label="Difference heatmap" src={result.evidence.diff} />
          <Evidence label="Overlay" src={result.evidence.overlay} />
        </div>
      )}
      <div className="review-grid">
        <div className="panel inset">
          <h3>Generated files</h3>
          {result.files.map((file) => (
            <div className="file-row" key={file.index}>
              <button onClick={() => void onSource(file.index)}>
                <span>{file.relativePath}</span>
                <small>
                  {formatBytes(file.byteLength)} · {shortHash(file.hash)}
                </small>
              </button>
              <a
                aria-label={`Download ${file.relativePath}`}
                href={`/api/runs/${run.runId}/download/file/${file.index}`}
              >
                ↓
              </a>
            </div>
          ))}
        </div>
        <div className="panel inset">
          <h3>Viewport evidence</h3>
          {result.viewports.map((viewport) => (
            <div className="finding" key={viewport.name}>
              <strong>
                {viewport.name} · {viewport.viewport.width} × {viewport.viewport.height}
              </strong>
              <span>{viewport.classification}</span>
              <small>
                {viewport.similarity === undefined
                  ? 'Robustness only; no false fidelity score'
                  : `${viewport.similarity.toFixed(3)}% similarity`}{' '}
                · {viewport.findingCount} findings
              </small>
            </div>
          ))}
        </div>
      </div>
      {source && (
        <div className="panel source">
          <div className="card-title">
            <h3>{source.relativePath}</h3>
            <span>{source.mediaType}</span>
          </div>
          <pre aria-label={`Source for ${source.relativePath}`}>
            <code>{highlight(source.source, source.mediaType)}</code>
          </pre>
        </div>
      )}
      <div className="review-grid">
        <div className="panel inset">
          <h3>Uncertainties</h3>
          {result.uncertainties.length === 0 ? (
            <p className="muted">No reported uncertainties.</p>
          ) : (
            result.uncertainties.map((item) => (
              <div className="finding" key={`${item.code}-${item.message}`}>
                <strong>{item.code}</strong>
                <span>confidence {item.confidence.toFixed(2)}</span>
                <small>{item.message}</small>
              </div>
            ))
          )}
        </div>
        <div className="panel inset">
          <h3>Accessibility and runtime findings</h3>
          {result.findings.length === 0 ? (
            <p className="good">No deterministic findings in the accepted pass.</p>
          ) : (
            result.findings.map((item) => (
              <div className="finding" key={item.id}>
                <strong>
                  {item.category} · {item.severity}
                </strong>
                <small>{item.message}</small>
              </div>
            ))
          )}
        </div>
      </div>
      {(result.warnings.length > 0 || result.failures.length > 0) && (
        <div className="panel inset">
          <h3>Warnings and failures</h3>
          <ul>
            {[
              ...result.warnings,
              ...result.failures.map((item) => `${item.code}: ${item.message}`),
            ].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="delete-zone">
        <button className="danger" onClick={() => void onDelete()}>
          Delete this run
        </button>
        <span>Deletes only this verified run directory.</span>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Evidence({ label, src }: { label: string; src: string }): ReactNode {
  return (
    <figure>
      <figcaption>{label}</figcaption>
      <img src={src} alt={label} />
    </figure>
  );
}

function highlight(source: string, mediaType: string): ReactNode[] {
  const pattern =
    mediaType === 'text/css'
      ? /([.#]?[\w-]+(?=\s*\{)|[\w-]+(?=\s*:)|#[a-fA-F0-9]{3,8}|\b\d+(?:\.\d+)?(?:px|rem|%|vh|vw)?\b)/gu
      : /(<\/?[\w:-]+|\/?\s*>|\s[\w:-]+(?==)|"[^"]*"|&[\w#]+;)/gu;
  return source.split(pattern).map((token, index) => (
    <span
      className={pattern.test(token) ? 'syntax' : undefined}
      key={`${index}-${token.slice(0, 8)}`}
    >
      {token}
    </span>
  ));
}

async function api<T = unknown>(
  path: string,
  csrfToken: string,
  init: RequestInit = {},
): Promise<T> {
  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...init.headers, 'X-Smart-UI-CSRF': csrfToken },
  }).then(readResponse<T>);
}

async function readResponse<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T & { message?: string; recovery?: string };
  if (!response.ok)
    throw Object.assign(new Error(value.message ?? `Request failed (${response.status}).`), {
      recovery: value.recovery,
    });
  return value;
}

function showFailure(setError: (value: { message: string; recovery?: string }) => void) {
  return (value: unknown) =>
    setError({
      message: value instanceof Error ? value.message : 'Studio operation failed.',
      ...(value instanceof Error && 'recovery' in value && typeof value.recovery === 'string'
        ? { recovery: value.recovery }
        : {}),
    });
}

function replaceRun(runs: RunSummary[], run: RunSummary): RunSummary[] {
  return runs.map((item) => (item.runId === run.runId ? run : item));
}
function stepFor(run: RunSummary): Step {
  return run.phase === 'inspected' ? 'boundaries' : isRunning(run.phase) ? 'handoff' : 'review';
}
function isRunning(phase: Phase | undefined): boolean {
  return (
    phase === 'generating' || phase === 'awaiting-agent' || phase === 'awaiting-agent-revision'
  );
}
export function shouldResetWorkflow(step: Step): boolean {
  return step === 'work-type';
}
export function hasRecentWork(runCount: number, taskCount: number): boolean {
  return runCount > 0 || taskCount > 0;
}
function canVisit(
  step: Step,
  workType: WorkType,
  run: RunSummary | undefined,
  task: HandoffTaskView | undefined,
): boolean {
  if (step === 'work-type' || step === 'inputs') return true;
  if (workType === 'validate') {
    if (step === 'boundaries') return true;
    if (step === 'handoff') return Boolean(task);
    return Boolean(task?.attempt);
  }
  if (step === 'boundaries') return run?.phase === 'inspected';
  if (step === 'handoff') return Boolean(run);
  return Boolean(run && run.phase !== 'inspected' && !isRunning(run.phase));
}
function title(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1).replaceAll('-', ' ') : value;
}
function shortHash(value: string): string {
  return `${value.slice(0, 18)}…${value.slice(-6)}`;
}
function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1_048_576
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1_048_576).toFixed(1)} MB`;
}
function layoutTitle(value: Layout): string {
  return value === 'fixed'
    ? 'Fixed page'
    : value === 'responsive'
      ? 'Responsive page'
      : 'Reusable component';
}
function modeHelp(value: Mode): string {
  return value === 'exact'
    ? 'Sanitized SVG in a semantic shell.'
    : value === 'hybrid'
      ? 'Semantic content with complex vector artwork retained.'
      : 'Prefer maintainable HTML and CSS where evidence supports it.';
}
function stageReached(stage: string, current: string): boolean {
  const order = [
    'agent',
    'sanitize',
    'inspect',
    'generate',
    'preview',
    'compare',
    'package',
    'report',
    'completed',
  ];
  return order.indexOf(stage) <= order.indexOf(current);
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('root');
  if (!root) throw new Error('Studio root element is missing.');
  createRoot(root).render(
    <StrictMode>
      <StudioApp />
    </StrictMode>,
  );
}
