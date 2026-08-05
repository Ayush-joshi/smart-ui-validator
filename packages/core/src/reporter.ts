import type { ArtifactStore, Reporter } from './providers.js';
import type { ArtifactRef, RunRecord, ValidationFinding } from './schemas.js';

export class HtmlReporter implements Reporter {
  constructor(private readonly artifacts: ArtifactStore) {}

  async write(record: RunRecord): Promise<ArtifactRef> {
    const finalScore = record.score !== undefined ? `${record.score}%` : 'N/A';
    const statusClass = record.status === 'succeeded' ? 'status-success' : record.status === 'failed' ? 'status-failed' : 'status-dry-run';

    // Generate HTML for the pass timeline
    const passesHtml = record.passes
      .map((pass) => {
        const screenshotPath = pass.screenshot ? pass.screenshot.relativePath : '';
        const heatmapPath = pass.heatmap ? pass.heatmap.relativePath : '';
        const revertedLabel = pass.reverted ? '<span class="badge badge-reverted">Reverted</span>' : '';
        const failuresList = pass.failures.map((f) => `<li><code class="fail-code">[${f.code}]</code> ${escape(f.message)}</li>`).join('');

        const findingsList = pass.findings
          .map((f) => {
            const locator = f.targetDomLocator ? `<code>${escape(f.targetDomLocator)}</code>` : '';
            return `<li class="finding-item category-${f.category} severity-${f.severity}">
              <div class="finding-header">
                <span class="finding-badge badge-${f.category}">${f.category.toUpperCase()}</span>
                <span class="finding-badge badge-sev-${f.severity}">${f.severity.toUpperCase()}</span>
                <span class="finding-message">${escape(f.message)}</span>
              </div>
              ${locator ? `<div class="finding-locator">DOM: ${locator}</div>` : ''}
              ${f.expected !== undefined ? `<div class="finding-details">Expected: <code>${escape(JSON.stringify(f.expected))}</code> | Actual: <code>${escape(JSON.stringify(f.actual))}</code></div>` : ''}
            </li>`;
          })
          .join('');

        return `
        <div class="pass-card">
          <div class="pass-card-header" onclick="togglePass(${pass.passIndex})">
            <div class="pass-title">
              <h3>Pass ${pass.passIndex} — Similarity: ${pass.score}%</h3>
              ${revertedLabel}
            </div>
            <div class="pass-meta">
              <span>Changed ${pass.changedFiles.length} files</span>
              <span>Findings: ${pass.findings.length}</span>
              <span class="toggle-icon" id="toggle-icon-${pass.passIndex}">▼</span>
            </div>
          </div>
          <div class="pass-card-content" id="pass-content-${pass.passIndex}" style="display: ${pass.passIndex === record.passes.length - 1 ? 'block' : 'none'}">
            <div class="pass-visuals">
              ${screenshotPath ? `
                <div class="visual-container">
                  <h4>Implementation Screenshot</h4>
                  <img src="${screenshotPath}" alt="Screenshot for Pass ${pass.passIndex}" class="visual-img" />
                </div>
              ` : ''}
              ${heatmapPath ? `
                <div class="visual-container">
                  <h4>Visual Diff Overlay</h4>
                  <img src="${heatmapPath}" alt="Heatmap for Pass ${pass.passIndex}" class="visual-img" />
                </div>
              ` : ''}
            </div>
            
            ${pass.changedFiles.length > 0 ? `
              <div class="pass-section">
                <h4>Files Changed</h4>
                <ul class="file-list">
                  ${pass.changedFiles.map((file) => `<li><code>${escape(file)}</code></li>`).join('')}
                </ul>
              </div>
            ` : ''}

            ${failuresList ? `
              <div class="pass-section text-error">
                <h4>Pass Failures / Regressions</h4>
                <ul>${failuresList}</ul>
              </div>
            ` : ''}

            <div class="pass-section">
              <h4>Findings (${pass.findings.length})</h4>
              <ul class="findings-list">
                ${findingsList || '<li>No findings in this pass.</li>'}
              </ul>
            </div>
          </div>
        </div>`;
      })
      .join('');

    // Aggregate decisions
    const decisionsHtml = record.decisions
      .map(
        (dec) =>
          `<div class="decision-item">
            <span class="decision-kind badge-${dec.kind}">${dec.kind.toUpperCase()}</span>
            <span class="decision-text">${escape(dec.message)}</span>
          </div>`,
      )
      .join('');

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Smart UI Validation Report — Run ${escape(record.id)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-main: #0B0F19;
      --bg-card: #151D30;
      --bg-header: #1E2942;
      --border-color: #2D3D60;
      --text-main: #F3F4F6;
      --text-muted: #9CA3AF;
      --accent: #3D63DD;
      --success: #10B981;
      --failed: #EF4444;
      --warning: #F59E0B;
      --dry-run: #8B5CF6;
    }

    * { box-sizing: border-box; }
    body {
      font-family: 'Outfit', system-ui, sans-serif;
      background: var(--bg-main);
      color: var(--text-main);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }

    .container {
      max-width: 1100px;
      margin: 40px auto;
      padding: 0 24px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 24px;
      margin-bottom: 32px;
    }

    .header-title h1 {
      margin: 0 0 8px;
      font-size: 32px;
      font-weight: 700;
      background: linear-gradient(135deg, #FFF, #9CA3AF);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    
    .header-title p {
      margin: 0;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
    }

    .status-badge {
      font-size: 16px;
      font-weight: 600;
      padding: 8px 16px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .status-success { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid var(--success); }
    .status-failed { background: rgba(239, 68, 68, 0.15); color: var(--failed); border: 1px solid var(--failed); }
    .status-dry-run { background: rgba(139, 92, 246, 0.15); color: var(--dry-run); border: 1px solid var(--dry-run); }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      transition: transform 0.2s;
    }
    .stat-card:hover { transform: translateY(-2px); }
    .stat-value { font-size: 36px; font-weight: 700; color: #FFF; margin-bottom: 4px; }
    .stat-label { font-size: 14px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

    h2 { font-size: 22px; font-weight: 600; margin: 0 0 20px; color: #FFF; display: flex; align-items: center; gap: 10px; }

    .section-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 32px;
    }

    .decision-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      border-bottom: 1px solid var(--border-color);
    }
    .decision-item:last-child { border-bottom: 0; }
    
    .badge {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge-framework { background: rgba(59, 130, 246, 0.2); color: #60A5FA; }
    .badge-change { background: rgba(16, 185, 129, 0.2); color: #34D399; }
    .badge-repair { background: rgba(245, 158, 11, 0.2); color: #FBBF24; }
    .badge-dry-run { background: rgba(139, 92, 246, 0.2); color: #A78BFA; }
    .badge-reverted { background: rgba(239, 68, 68, 0.2); color: #F87171; }

    /* Pass Timeline */
    .pass-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      margin-bottom: 16px;
      overflow: hidden;
    }

    .pass-card-header {
      background: var(--bg-header);
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      transition: background 0.2s;
    }
    .pass-card-header:hover { background: #263352; }

    .pass-title { display: flex; align-items: center; gap: 12px; }
    .pass-title h3 { margin: 0; font-size: 18px; font-weight: 600; }

    .pass-meta { display: flex; align-items: center; gap: 16px; color: var(--text-muted); font-size: 14px; }
    .toggle-icon { transition: transform 0.2s; font-size: 12px; }

    .pass-card-content {
      padding: 24px;
      border-top: 1px solid var(--border-color);
    }

    .pass-visuals {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 24px;
      margin-bottom: 24px;
    }

    .visual-container {
      background: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .visual-container h4 { margin: 0 0 12px; font-size: 14px; color: var(--text-muted); align-self: flex-start; }
    .visual-img {
      max-width: 100%;
      height: auto;
      max-height: 400px;
      object-fit: contain;
      border-radius: 4px;
      border: 1px solid var(--border-color);
      background: #FFF; /* white canvas display backplate */
    }

    .pass-section { margin-bottom: 20px; }
    .pass-section:last-child { margin-bottom: 0; }
    .pass-section h4 { margin: 0 0 8px; font-size: 15px; text-transform: uppercase; color: var(--text-muted); }

    .file-list { margin: 0; padding-left: 20px; font-family: 'JetBrains Mono', monospace; font-size: 14px; }
    .text-error { color: var(--failed); }
    .fail-code { background: rgba(239, 68, 68, 0.15); color: var(--failed); padding: 2px 6px; border-radius: 4px; }

    /* Findings List */
    .findings-list { list-style: none; padding: 0; margin: 0; }
    .finding-item {
      background: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
      border-left: 4px solid var(--border-color);
    }
    .finding-item.severity-error { border-left-color: var(--failed); }
    .finding-item.severity-warning { border-left-color: var(--warning); }
    .finding-item.severity-info { border-left-color: var(--accent); }

    .finding-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
    .finding-message { font-weight: 500; color: #FFF; font-size: 15px; }
    
    .finding-badge { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 3px; color: #FFF; }
    
    /* Category Badges */
    .badge-geometry { background: #3B82F6; }
    .badge-typography { background: #EC4899; }
    .badge-appearance { background: #10B981; }
    .badge-accessibility { background: #8B5CF6; }
    .badge-raster { background: #E11D48; }
    .badge-runtime { background: #F59E0B; }

    /* Severity Badges */
    .badge-sev-error { background: rgba(239, 68, 68, 0.2); color: var(--failed); border: 1px solid var(--failed); }
    .badge-sev-warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); border: 1px solid var(--warning); }
    .badge-sev-info { background: rgba(59, 130, 246, 0.2); color: #60A5FA; border: 1px solid #60A5FA; }

    .finding-locator { font-size: 13px; color: var(--text-muted); margin-bottom: 4px; }
    .finding-details { font-size: 13px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; }

    code { font-family: 'JetBrains Mono', monospace; font-size: 13px; background: rgba(255,255,255,0.06); padding: 2px 4px; border-radius: 4px; }

  </style>
  <script>
    function togglePass(index) {
      const content = document.getElementById('pass-content-' + index);
      const icon = document.getElementById('toggle-icon-' + index);
      if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.style.transform = 'rotate(180deg)';
      } else {
        content.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
      }
    }
  </script>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-title">
        <h1>Smart UI Validation Report</h1>
        <p>RUN: ${escape(record.id)}</p>
      </div>
      <div class="status-badge ${statusClass}">
        ${escape(record.status)}
      </div>
    </header>

    <div class="summary-grid">
      <div class="stat-card">
        <div class="stat-value">${finalScore}</div>
        <div class="stat-label">Similarity Score</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${record.passes.length}</div>
        <div class="stat-label">Repair Passes</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${record.changedFiles.length}</div>
        <div class="stat-label">Files Modified</div>
      </div>
    </div>

    <div class="section-card">
      <h2>Decisions Log</h2>
      <div class="decisions-container">
        ${decisionsHtml || '<p class="text-muted">No execution decisions logged.</p>'}
      </div>
    </div>

    <h2>Pass History & Timeline</h2>
    <div class="passes-container">
      ${passesHtml || '<p class="text-muted">No repair passes executed.</p>'}
    </div>
  </div>
</body>
</html>`;
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
