import type { ArtifactStore, Reporter } from './providers.js';
import type { ArtifactRef, RunRecord } from './schemas.js';

export class HtmlReporter implements Reporter {
  constructor(private readonly artifacts: ArtifactStore) {}

  async write(record: RunRecord): Promise<ArtifactRef> {
    const artifacts = record.artifacts
      .map(
        (artifact) =>
          `<li><code>${escape(artifact.hash)}</code> — ${escape(artifact.relativePath)}</li>`,
      )
      .join('');
    const failures = record.failures
      .map((failure) => `<li>${escape(failure.message)}</li>`)
      .join('');
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Smart UI run ${escape(record.id)}</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 20px;color:#172033}code{background:#eef1f5;padding:2px 5px}dt{font-weight:700}dd{margin-bottom:12px}</style><h1>Smart UI run</h1><dl><dt>ID</dt><dd>${escape(record.id)}</dd><dt>Status</dt><dd>${escape(record.status)}</dd><dt>Target</dt><dd>${escape(record.targetRoot)}</dd></dl><h2>Artifacts</h2><ul>${artifacts}</ul><h2>Changed files</h2><pre>${escape(record.changedFiles.join('\n') || '(none)')}</pre><h2>Failures</h2><ul>${failures || '<li>None</li>'}</ul></html>`;
    return this.artifacts.put(new TextEncoder().encode(html), 'text/html', `${record.id}.html`);
  }
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
