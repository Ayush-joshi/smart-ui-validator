import React, { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

type Phase =
  | 'inspected'
  | 'generating'
  | 'awaiting-agent'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted';

interface RunSummary {
  runId: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  progress: { stage: string; value: number; message: string };
  inspection?: {
    filename: string;
    width: number;
    height: number;
    readableTextNodes: number;
    originalInputHash: string;
    sanitizedHash: string;
    sanitization: { accepted: boolean; nodeCount: number; decisions: string[] };
    uncertaintyCount: number;
    recommendedModes: Mode[];
  };
  generation: null | {
    generationId: string;
    status: string;
    stoppedReason: string;
    engine: Engine;
    agent: null | { host: string; accepted: boolean };
    requestedMode: Mode;
    finalMode?: Mode;
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
    evidence: null | { screenshot: string; diff: string; overlay: string };
  };
  error?: { code: string; message: string; recovery: string };
}

type Mode = 'exact' | 'hybrid' | 'semantic';
type Layout = 'fixed' | 'responsive' | 'component';
type Engine = 'agent' | 'deterministic';
type Step = 'input' | 'preferences' | 'generate' | 'review';

interface SessionResponse {
  csrfToken: string;
  runs: RunSummary[];
  limits: { maxUploadBytes: number };
  agent: { configured: boolean; transport: 'mcp'; workspace: string };
}

interface SourceFile {
  relativePath: string;
  mediaType: string;
  source: string;
}

export function StudioApp(): ReactNode {
  const [session, setSession] = useState<SessionResponse>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [step, setStep] = useState<Step>('input');
  const [engine, setEngine] = useState<Engine>('agent');
  const [mode, setMode] = useState<Mode>('hybrid');
  const [layout, setLayout] = useState<Layout>('responsive');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; recovery?: string }>();
  const [source, setSource] = useState<SourceFile>();
  const inputRef = useRef<HTMLInputElement>(null);
  const active = runs.find((run) => run.runId === activeId);

  useEffect(() => {
    void fetch('/api/session', { credentials: 'same-origin' })
      .then(readResponse<SessionResponse>)
      .then((value) => {
        setSession(value);
        setRuns(value.runs);
        if (!value.agent.configured) setEngine('deterministic');
        const latest = value.runs.at(-1);
        if (latest) {
          setActiveId(latest.runId);
          setStep(stepFor(latest));
        }
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

  async function upload(file: File): Promise<void> {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    setSource(undefined);
    try {
      if (!file.name.toLowerCase().endsWith('.svg')) throw new Error('Choose one .svg file.');
      if (file.size > session.limits.maxUploadBytes) {
        throw new Error(`SVG exceeds the ${formatBytes(session.limits.maxUploadBytes)} limit.`);
      }
      const run = await api<RunSummary>('/api/runs', session.csrfToken, {
        method: 'POST',
        headers: { 'Content-Type': 'image/svg+xml', 'X-Smart-UI-Filename': file.name },
        body: file,
      });
      setRuns((current) => [...current, run]);
      setActiveId(run.runId);
      setMode(
        engine === 'agent' ? 'semantic' : (run.inspection?.recommendedModes[0] ?? 'hybrid'),
      );
      setStep('preferences');
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
        body: JSON.stringify({
          engine,
          mode,
          layout,
          ...(instructions.trim() ? { instructions } : {}),
        }),
      });
      setRuns((current) => replaceRun(current, run));
      setStep('generate');
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

  function newRun(): void {
    setActiveId(undefined);
    setStep('input');
    setEngine(session?.agent.configured ? 'agent' : 'deterministic');
    setMode('hybrid');
    setLayout('responsive');
    setInstructions('');
    setSource(undefined);
    setError(undefined);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local-only SVG generation</p>
          <h1>Smart UI Studio</h1>
        </div>
        <div className="top-actions">
          <span className="local-badge">127.0.0.1 · telemetry off</span>
          {active && <button onClick={newRun}>New run</button>}
        </div>
      </header>

      <nav className="steps" aria-label="Generation steps">
        {(['input', 'preferences', 'generate', 'review'] as Step[]).map((item, index) => (
          <button
            key={item}
            className={step === item ? 'active' : ''}
            disabled={!canVisit(item, active)}
            aria-current={step === item ? 'step' : undefined}
            onClick={() => setStep(item)}
          >
            <span>{index + 1}</span> {title(item)}
          </button>
        ))}
      </nav>

      {error && (
        <div className="alert" role="alert">
          <strong>{error.message}</strong>
          {error.recovery && <p>{error.recovery}</p>}
        </div>
      )}

      <main>
        {step === 'input' && (
          <section className="panel input-panel" aria-labelledby="input-title">
            <p className="eyebrow">Step 1</p>
            <h2 id="input-title">Choose one SVG</h2>
            <p className="lede">
              The file is streamed into a new isolated run and sanitized before anything is shown or
              rendered.
            </p>
            <label
              className="dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) void upload(file);
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept="image/svg+xml,.svg"
                disabled={busy || !session}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <strong>{busy ? 'Inspecting safely…' : 'Choose or drop an SVG'}</strong>
              <span>
                Maximum {session ? formatBytes(session.limits.maxUploadBytes) : 'loading…'} · no
                external resources
              </span>
            </label>
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

        {step === 'preferences' && active?.inspection && (
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
                <span>Sanitization</span>
                <strong className="good">Accepted</strong>
              </div>
            </div>
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
            <p className="eyebrow">Step 2</p>
            <h2 id="preferences-title">Set implementation preferences</h2>
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
                    The MCP-connected chat agent authors real HTML and CSS from the design
                    evidence; deterministic checks then render, measure, and verify it.
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
            <div className="actions">
              <button className="primary" disabled={busy} onClick={() => void generate()}>
                {engine === 'agent' ? 'Generate with AI agent' : 'Generate offline bundle'}
              </button>
            </div>
          </section>
        )}

        {step === 'generate' && active && (
          <section className="panel progress-panel" aria-labelledby="generate-title">
            <p className="eyebrow">Step 3</p>
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
            {active.phase === 'awaiting-agent' && (
              <div className="agent-waiting">
                <p>
                  Paste this into the chat connected to the <code>smart-ui</code> MCP server, then
                  keep this tab open while the agent authors the design:
                </p>
                <code>
                  {`Use the smart-ui MCP server. Call list_studio_authoring_requests with studioWorkspace "${session?.agent.workspace ?? ''}", author complete offline index.html and styles.css for run ${active.runId} (no scripts, no external URLs), then call submit_studio_authored_html with approved: true and that exact runId.`}
                </code>
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

        {step === 'review' && active && (
          <Review run={active} source={source} onSource={openSource} onDelete={removeRun} />
        )}
      </main>
      <footer>
        Runs remain plaintext in the dedicated local workspace until deleted or expired.
      </footer>
    </div>
  );
}

export function Review({
  run,
  source,
  onSource,
  onDelete,
}: {
  run: RunSummary;
  source: SourceFile | undefined;
  onSource(index: number): Promise<void>;
  onDelete(): Promise<void>;
}): ReactNode {
  const result = run.generation;
  if (run.phase === 'canceled' || !result) {
    return (
      <section className="panel">
        <p className="eyebrow">Step 4</p>
        <h2>{run.phase === 'canceled' ? 'Generation canceled' : 'Generation did not complete'}</h2>
        <p>{run.error?.message ?? run.progress.message}</p>
        {run.error?.recovery && <p>{run.error.recovery}</p>}
      </section>
    );
  }
  return (
    <section className="review" aria-labelledby="review-title">
      <div className="review-header">
        <div>
          <p className="eyebrow">Step 4</p>
          <h2 id="review-title">Review deterministic evidence</h2>
          <p>
            {run.filename} · {result.requestedMode}
            {result.finalMode && result.finalMode !== result.requestedMode
              ? ` → ${result.finalMode}`
              : ''}
          </p>
          <p className={result.engine === 'agent' && result.agent?.accepted ? 'engine-note good' : 'engine-note'}>
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
              ? 'Not scored'
              : `${result.visualSimilarity.toFixed(3)}%`
          }
        />
        <Metric
          label="Visual mismatch"
          value={
            result.visualMismatchPercent === null
              ? 'Not scored'
              : `${result.visualMismatchPercent.toFixed(3)}%`
          }
        />
        <Metric label="Uncertainties" value={String(result.uncertaintyCount)} />
        <Metric label="Final mode" value={result.finalMode ?? result.requestedMode} />
      </div>
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
          <Evidence label="Generated output" src={result.evidence.screenshot} />
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
  return run.phase === 'inspected'
    ? 'preferences'
    : isRunning(run.phase)
      ? 'generate'
      : 'review';
}
function isRunning(phase: Phase | undefined): boolean {
  return phase === 'generating' || phase === 'awaiting-agent';
}
function canVisit(step: Step, run: RunSummary | undefined): boolean {
  return (
    step === 'input' ||
    Boolean(
      run &&
        (step === 'preferences'
          ? run.phase === 'inspected'
          : step === 'generate'
            ? isRunning(run.phase)
            : run.phase !== 'inspected'),
    )
  );
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
