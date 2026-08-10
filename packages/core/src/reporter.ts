import type { ArtifactStore, Reporter } from './providers.js';
import type { ArtifactRef, RunRecord } from './schemas.js';

/** Produces a self-contained, network-free report with paths valid from the object directory. */
export class HtmlReporter implements Reporter {
  constructor(private readonly artifacts: ArtifactStore) {}

  async write(record: RunRecord): Promise<ArtifactRef> {
    const firstPass = record.passes[0];
    const finalPass = record.passes.at(-1);
    const summaryVisuals = [
      visual('Target', record.targetArtifact),
      visual('Before', firstPass?.screenshot),
      visual('After', finalPass?.screenshot),
      visual('Overlay', finalPass?.overlay),
      visual('Diff', finalPass?.diff),
    ].join('');
    const passes = record.passes
      .map(
        (pass) => `<details ${pass === finalPass ? 'open' : ''}>
          <summary>
            <strong>Validation ${pass.passIndex}</strong>
            <span>score ${formatScore(pass.score)}</span>
            ${pass.diffPercent === undefined ? '' : `<span>visual mismatch ${formatScore(pass.diffPercent)}</span>`}
            <span>${pass.findings.length} findings</span>
            ${pass.reverted ? '<span class="danger">reverted</span>' : ''}
          </summary>
          <div class="pass-body">
            <div class="visual-grid">
              ${visual('Implementation', pass.screenshot)}
              ${visual('Overlay', pass.overlay)}
              ${visual('Diff', pass.diff)}
            </div>
            ${pass.proposal ? `<section><h4>Proposed patch</h4><p><code>${escape(pass.proposal.hash)}</code></p><ul>${pass.proposal.files.map((file, index) => `<li><code>${escape(file)}</code> — ${escape(pass.proposal?.rationale[index] ?? '')}</li>`).join('')}</ul></section>` : ''}
            ${pass.failures.length ? `<section><h4>Pass failures</h4><ul>${pass.failures.map((failure) => `<li class="danger"><code>${escape(failure.code)}</code>: ${escape(failure.message)}</li>`).join('')}</ul></section>` : ''}
            <section><h4>Findings</h4>${findings(pass.findings)}</section>
          </div>
        </details>`,
      )
      .join('');
    const decisions = record.decisions
      .map(
        (decision) =>
          `<li><span class="pill">${escape(decision.kind)}</span>${escape(decision.message)}</li>`,
      )
      .join('');
    const failures = record.failures
      .map(
        (failure) =>
          `<li class="danger"><code>${escape(failure.code)}</code>: ${escape(failure.message)}</li>`,
      )
      .join('');

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Smart UI report ${escape(record.id)}</title>
  <style>
    :root{color-scheme:dark;--bg:#0b1020;--card:#151d30;--line:#2d3d60;--text:#f3f4f6;--muted:#aab4c5;--accent:#7da2ff;--danger:#ff8585;--ok:#66d9a7}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:1180px;margin:0 auto;padding:32px 20px 64px}header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:20px}
    h1,h2,h3,h4,p{margin-top:0}.meta{color:var(--muted)}.status{border:1px solid var(--line);border-radius:999px;padding:7px 12px;height:max-content}.status-succeeded{color:var(--ok)}.status-failed{color:var(--danger)}
    .stats,.visual-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}.stats{margin:22px 0}.stat,section,details{background:var(--card);border:1px solid var(--line);border-radius:10px}.stat{padding:16px}.stat strong{display:block;font-size:24px}.stat span{color:var(--muted)}
    section{padding:18px;margin:18px 0}.visual-grid{margin:16px 0}.visual{background:#070b15;border:1px solid var(--line);border-radius:8px;padding:10px}.visual h4{color:var(--muted);margin-bottom:8px}.visual img{display:block;width:100%;max-height:420px;object-fit:contain;background:#fff}
    details{margin:12px 0;overflow:hidden}summary{display:flex;flex-wrap:wrap;gap:18px;cursor:pointer;padding:15px 18px;background:#1c2740}.pass-body{padding:0 18px 4px}
    ul{padding-left:20px}.decision-list{list-style:none;padding:0}.decision-list li{display:flex;gap:10px;border-bottom:1px solid var(--line);padding:9px 0}.pill{color:var(--accent);min-width:90px}code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;background:#090e1c;padding:2px 5px;border-radius:4px}.danger{color:var(--danger)}
    .finding{border-left:3px solid var(--accent);padding:10px 12px;margin:8px 0;background:#0e1527}.finding.error{border-color:var(--danger)}.finding.warning{border-color:#ffc66d}.finding-head{display:flex;flex-wrap:wrap;gap:8px}.finding-data{color:var(--muted);margin-top:5px;overflow-wrap:anywhere}
  </style>
</head>
<body><main>
  <header><div><h1>Smart UI validation report</h1><div class="meta">Run <code>${escape(record.id)}</code></div></div><div class="status status-${escape(record.status)}">${escape(record.status)} · ${escape(record.stoppedReason)}</div></header>
  <div class="stats">
    <div class="stat"><strong>${record.score === undefined ? 'N/A' : formatScore(record.score)}</strong><span>final score</span></div>
    <div class="stat"><strong>${finalPass?.diffPercent === undefined ? 'N/A' : formatScore(finalPass.diffPercent)}</strong><span>visual mismatch</span></div>
    <div class="stat"><strong>${record.passes.length}</strong><span>validation records</span></div>
    <div class="stat"><strong>${record.changedFiles.length}</strong><span>retained file changes</span></div>
    <div class="stat"><strong>${finalPass?.findings.length ?? 0}</strong><span>remaining findings</span></div>
  </div>
  <section><h2>Evidence</h2><div class="visual-grid">${summaryVisuals}</div></section>
  <section><h2>Decisions</h2><ul class="decision-list">${decisions || '<li>No decisions recorded.</li>'}</ul></section>
  ${failures ? `<section><h2>Run failures</h2><ul>${failures}</ul></section>` : ''}
  <h2>Pass history</h2>${passes || '<p>No browser pass completed.</p>'}
  <section><h2>Remaining work</h2>${finalPass ? findings(finalPass.findings) : '<p>Browser validation did not complete.</p>'}</section>
</main></body></html>`;
    return this.artifacts.put(new TextEncoder().encode(html), 'text/html', `${record.id}.html`);
  }
}

function visual(label: string, artifact: ArtifactRef | undefined): string {
  if (!artifact || !artifact.mediaType.startsWith('image/')) return '';
  return `<div class="visual"><h4>${escape(label)}</h4><img src="${escape(artifactHref(artifact))}" alt="${escape(label)} evidence"></div>`;
}

function artifactHref(artifact: ArtifactRef): string {
  return `../../${artifact.relativePath.replaceAll('\\', '/')}`;
}

function findings(items: RunRecord['passes'][number]['findings']): string {
  if (items.length === 0) return '<p>No findings.</p>';
  return items
    .map(
      (finding) => `<div class="finding ${escape(finding.severity)}">
        <div class="finding-head"><strong>${escape(finding.category)}</strong><span>${escape(finding.severity)}</span><span>${escape(finding.message)}</span></div>
        ${finding.targetDomLocator ? `<div class="finding-data">DOM: <code>${escape(finding.targetDomLocator)}</code></div>` : ''}
        ${finding.expected !== undefined ? `<div class="finding-data">Expected: <code>${escapeJson(finding.expected)}</code><br>Actual: <code>${escapeJson(finding.actual)}</code></div>` : ''}
      </div>`,
    )
    .join('');
}

function formatScore(value: number): string {
  return `${value
    .toFixed(3)
    .replace(/\.0+$|0+$/g, '')
    .replace(/\.$/, '')}%`;
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeJson(value: unknown): string {
  return escape(JSON.stringify(value) ?? 'undefined');
}
