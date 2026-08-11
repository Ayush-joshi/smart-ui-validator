import type { GenerationRecord } from './generation-contracts.js';
import type { GenerationReporter } from './generation-providers.js';
import type { ArtifactStore } from './providers.js';
import type { ArtifactRef } from './schemas.js';

export class HtmlGenerationReporter implements GenerationReporter {
  constructor(private readonly artifacts: ArtifactStore) {}

  async write(record: GenerationRecord, signal?: AbortSignal): Promise<ArtifactRef> {
    if (signal?.aborted)
      throw new Error('Generation report was canceled before it could be written.');
    const source = record.sanitizedSource;
    const finalPass = [...record.passes].reverse().find((pass) => pass.accepted);
    const visuals = [
      visual('Sanitized SVG reference', source),
      visual('Generated output', finalPass?.screenshot),
      visual('Overlay', finalPass?.overlay),
      visual('Diff', finalPass?.diff),
    ].join('');
    const files = record.generatedFiles
      .map(
        (file) =>
          `<li><code>${escape(file.relativePath)}</code> <span>${escape(file.hash.slice(0, 19))} · ${file.byteLength} bytes</span></li>`,
      )
      .join('');
    const decisions = record.decisions
      .map(
        (decision) =>
          `<li><strong>${escape(decision.kind)}</strong> ${escape(decision.message)} <span>confidence ${decision.confidence.toFixed(2)}</span></li>`,
      )
      .join('');
    const uncertainties = record.uncertainties
      .map(
        (item) =>
          `<li><strong>${escape(item.code)}</strong> ${escape(item.message)} <span>confidence ${item.confidence.toFixed(2)}</span></li>`,
      )
      .join('');
    const viewports = record.viewports
      .map(
        (item) =>
          `<tr><td>${escape(item.name)}</td><td>${item.viewport.width}×${item.viewport.height}</td><td>${escape(item.classification)}</td><td>${item.similarity === undefined ? 'not scored' : `${item.similarity.toFixed(3)}%`}</td><td>${item.findings.length}</td></tr>`,
      )
      .join('');
    const presentation =
      record.schemaVersion === '2.0'
        ? `<p>Primary canvas <code>${escape(record.input.presentationSpec.primaryCanvas.id)}</code>: ${record.input.presentationSpec.primaryCanvas.width}×${record.input.presentationSpec.primaryCanvas.height} at DPR ${record.input.presentationSpec.primaryCanvas.deviceScaleFactor}; fit ${escape(record.input.presentationSpec.fit)}; alignment ${escape(record.input.presentationSpec.horizontalAlignment)}/${escape(record.input.presentationSpec.verticalAlignment)}.</p><p>Structured context <code>${escape(record.input.structuredContextHash)}</code>${record.designBundle ? `; full validated typed evidence is retained in <a href="${escape(artifactHref(record.designBundle))}">the design bundle</a>` : ''}.</p>`
        : '<p>Legacy intrinsic-canvas record (schema 1.0).</p>';
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smart UI SVG generation ${escape(record.id)}</title>
<style>
:root{color-scheme:dark;--bg:#09111f;--card:#111c2f;--line:#2b3d59;--text:#f4f7fb;--muted:#aebbd0;--accent:#72a7ff;--warn:#ffca72}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:30px 20px 60px}header{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:18px}h1,h2,p{margin-top:0}.status{color:var(--accent)}.muted,li span{color:var(--muted)}.stats,.visuals{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}.stats{margin:20px 0}.card,section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}.card strong{display:block;font-size:22px}.visual img{display:block;width:100%;max-height:420px;object-fit:contain;background:#fff}.visual h3{font-size:13px;color:var(--muted)}code{font:12px ui-monospace,monospace;background:#060b14;padding:2px 5px;border-radius:4px}li{margin:7px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid var(--line)}th{color:var(--muted)}
</style></head><body><main>
<header><div><h1>SVG-to-HTML generation</h1><div class="muted"><code>${escape(record.id)}</code></div></div><div class="status">${escape(record.status)} · ${escape(record.stoppedReason)}</div></header>
<div class="stats"><div class="card"><strong>${escape(record.input.finalMode ?? record.input.requestedMode)}</strong><span>final mode</span></div><div class="card"><strong>${finalPass ? `${(100 - finalPass.diffPercent).toFixed(3)}%` : 'N/A'}</strong><span>visual similarity</span></div><div class="card"><strong>${record.sanitization.nodeCount}</strong><span>sanitized nodes</span></div><div class="card"><strong>${record.uncertainties.length}</strong><span>uncertainties</span></div></div>
<section><h2>Evidence</h2><div class="visuals">${visuals || '<p>No rendered evidence was produced.</p>'}</div></section>
<section><h2>Generated files</h2><ul>${files || '<li>No deliverable was written.</li>'}</ul></section>
	<section><h2>Viewport evidence</h2><table><thead><tr><th>Name</th><th>Viewport</th><th>Classification</th><th>Similarity</th><th>Findings</th></tr></thead><tbody>${viewports}</tbody></table></section>
	<section><h2>Presentation and design context</h2>${presentation}</section>
<section><h2>Sanitization</h2><p>Original <code>${escape(record.originalInputHash)}</code><br>Sanitized <code>${escape(record.sanitizedHash ?? 'not accepted')}</code></p><ul>${record.sanitization.decisions.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></section>
<section><h2>Decisions</h2><ul>${decisions || '<li>No generation decisions.</li>'}</ul></section>
<section><h2>Uncertainties</h2><ul>${uncertainties || '<li>No reported uncertainties.</li>'}</ul></section>
</main></body></html>`;
    return this.artifacts.put(
      new TextEncoder().encode(html),
      'text/html',
      `${record.id}-generation-report.html`,
    );
  }
}

function visual(label: string, artifact: ArtifactRef | undefined): string {
  if (!artifact || !artifact.mediaType.startsWith('image/')) return '';
  return `<div class="visual"><h3>${escape(label)}</h3><img src="${escape(artifactHref(artifact))}" alt="${escape(label)}"></div>`;
}

function artifactHref(artifact: ArtifactRef): string {
  return `../../${artifact.relativePath.replaceAll('\\', '/')}`;
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
