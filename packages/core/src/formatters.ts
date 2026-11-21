import path from 'node:path';
import type { AuditReport, Severity } from './types.js';

function sarifLevel(sev: Severity): 'error' | 'warning' | 'note' {
  if (sev === 'error') return 'error';
  if (sev === 'warning') return 'warning';
  return 'note';
}

export function formatSarif(report: AuditReport): string {
  const uniqueRules = new Map<string, { id: string; shortDescription: { text: string } }>();
  for (const f of report.findings) {
    if (!uniqueRules.has(f.id)) {
      uniqueRules.set(f.id, {
        id: f.id,
        shortDescription: { text: f.message },
      });
    }
  }

  const sarif = {
    $schema:
      'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ArchPilot',
            version: '0.1.0',
            informationUri: 'https://github.com/jacob-git/archpilot',
            rules: Array.from(uniqueRules.values()),
          },
        },
        results: report.findings.map((f) => ({
          ruleId: f.id,
          level: sarifLevel(f.severity),
          message: {
            text: f.suggestion ? `${f.message} Fix: ${f.suggestion}` : f.message,
          },
          ...(f.file
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: f.file },
                      region: { startLine: f.line ?? 1 },
                    },
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

export function formatMarkdown(report: AuditReport): string {
  const repoName = path.basename(report.rootDir);
  const stackTags = [
    ...report.detectedStack.languages,
    ...report.detectedStack.frameworks,
    ...report.detectedStack.capabilities,
  ];

  const lines: string[] = [
    `## ArchPilot Report — \`${repoName}\``,
    '',
    `**Overall Score:** **${report.overallScore}/100 (Grade ${report.grade})** · ${report.summary.errors} errors · ${report.summary.warnings} warnings · ${report.summary.infos} info`,
  ];

  if (stackTags.length > 0) {
    lines.push(`**Detected Stack:** ${stackTags.map((t) => `\`${t}\``).join(' ')}`);
  }

  const tf = report.tokenFootprint;
  const c = tf.costEstimate;
  const savingsText =
    c.potentialMonthlySavingsUsd > 0
      ? ` · **Potential savings: ~$${c.potentialMonthlySavingsUsd.toFixed(2)}/mo/dev**`
      : '';
  lines.push(
    `**Token Cost (${c.modelLabel}):** ~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} always-on tok/turn (~$${c.alwaysOnMonthlyUsd.toFixed(2)}/mo/dev) · ${tf.tokenSinks.length} token sinks (~$${c.sinkMonthlyRiskUsd.toFixed(2)}/mo risk)${savingsText}`
  );

  lines.push('', '| Category | Score | Findings |', '| :--- | :---: | :---: |');
  for (const cat of report.categories) {
    lines.push(`| ${cat.label} | **${cat.score}/100** | ${cat.findings.length} |`);
  }

  if (report.findings.length > 0) {
    lines.push('', '### Findings', '');
    for (const f of report.findings.slice(0, 50)) {
      const icon = f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
      const loc = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      lines.push(`- ${icon} **\`${f.id}\`**${loc} — ${f.message}`);
      if (f.suggestion) {
        lines.push(`  - *Fix:* ${f.suggestion}`);
      }
    }
    if (report.findings.length > 50) {
      lines.push(`- *...and ${report.findings.length - 50} more findings.*`);
    }
  } else {
    lines.push('', '✅ No issues found. Repository passed all ArchPilot guardrails.');
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatHtmlReport(report: AuditReport): string {
  const repoName = path.basename(report.rootDir);
  const stackTags = [
    ...report.detectedStack.languages,
    ...report.detectedStack.frameworks,
    ...report.detectedStack.capabilities,
  ];
  const tf = report.tokenFootprint;
  const c = tf.costEstimate;
  const scoreColor =
    report.overallScore >= 85 ? '#34d399' : report.overallScore >= 65 ? '#fbbf24' : '#f87171';

  const categoryRows = report.categories
    .map(
      (cat) => `
      <div class="cat-row">
        <div class="cat-name">${escapeHtml(cat.label)}</div>
        <div class="bar-wrap"><div class="bar" style="width:${cat.score}%;background:${
          cat.score >= 85 ? '#34d399' : cat.score >= 65 ? '#fbbf24' : '#f87171'
        }"></div></div>
        <div class="cat-score">${cat.score}/100</div>
      </div>`
    )
    .join('');

  const findingRows =
    report.findings.length === 0
      ? '<p class="ok">All ArchPilot architecture, security, QA, and token guardrails passed.</p>'
      : report.findings
          .map(
            (f) => `
        <div class="finding ${f.severity}">
          <div class="finding-head">
            <span class="sev ${f.severity}">${f.severity.toUpperCase()}</span>
            <code>${escapeHtml(f.id)}</code>
            ${f.file ? `<span class="loc">${escapeHtml(f.file)}${f.line ? `:${f.line}` : ''}</span>` : ''}
          </div>
          <div class="finding-msg">${escapeHtml(f.message)}</div>
          ${f.suggestion ? `<div class="finding-fix">Fix: ${escapeHtml(f.suggestion)}</div>` : ''}
        </div>`
          )
          .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ArchPilot Executive Report — ${escapeHtml(repoName)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #e2e8f0; margin: 0; padding: 32px; }
  .container { max-width: 920px; margin: 0 auto; }
  .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
  h1 { margin: 0 0 6px; font-size: 22px; color: #f8fafc; }
  .sub { color: #94a3b8; font-size: 13px; }
  .score-box { text-align: right; }
  .score { font-size: 36px; font-weight: 700; color: ${scoreColor}; line-height: 1; }
  .grade { font-size: 13px; color: #94a3b8; margin-top: 4px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 18px; }
  .kpi { background: #1e293b; border-radius: 8px; padding: 12px; }
  .kpi-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; }
  .kpi-val { font-size: 16px; font-weight: 600; color: #f8fafc; margin-top: 4px; }
  .cat-row { display: grid; grid-template-columns: 220px 1fr 70px; align-items: center; gap: 12px; margin: 10px 0; font-size: 13px; }
  .bar-wrap { background: #1e293b; height: 10px; border-radius: 999px; overflow: hidden; }
  .bar { height: 100%; border-radius: 999px; }
  .cat-score { text-align: right; font-weight: 600; }
  h2 { font-size: 16px; margin: 0 0 14px; color: #f8fafc; }
  .finding { border-left: 3px solid #38bdf8; background: #111c33; padding: 10px 14px; border-radius: 6px; margin-bottom: 10px; }
  .finding.error { border-color: #f87171; }
  .finding.warning { border-color: #fbbf24; }
  .finding-head { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 4px; flex-wrap: wrap; }
  .sev { font-weight: 700; font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #1e293b; }
  .sev.error { color: #f87171; }
  .sev.warning { color: #fbbf24; }
  .sev.info { color: #38bdf8; }
  .loc { color: #94a3b8; }
  .finding-msg { font-size: 13px; color: #f1f5f9; }
  .finding-fix { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  .ok { color: #34d399; font-weight: 500; }
  @media print { body { background: #fff; color: #0f172a; } .card, .kpi, .finding { background: #f8fafc; border-color: #cbd5e1; } }
</style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div>
          <h1>ArchPilot Executive Audit Report — ${escapeHtml(repoName)}</h1>
          <div class="sub">${report.summary.filesScanned} files scanned in ${report.summary.durationMs}ms · Stack: ${escapeHtml(stackTags.join(' · ') || 'generic')}</div>
        </div>
        <div class="score-box">
          <div class="score">${report.overallScore}/100</div>
          <div class="grade">Grade ${report.grade} · ${report.summary.errors}E / ${report.summary.warnings}W / ${report.summary.infos}I</div>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="kpi-label">Always-On Instructions</div><div class="kpi-val">~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} tok/turn</div></div>
        <div class="kpi"><div class="kpi-label">Est. Monthly Cost (${escapeHtml(c.modelLabel)})</div><div class="kpi-val">~$${(c.alwaysOnMonthlyUsd + c.sinkMonthlyRiskUsd).toFixed(2)}/mo/dev</div></div>
        <div class="kpi"><div class="kpi-label">Potential Monthly Savings</div><div class="kpi-val">~$${c.potentialMonthlySavingsUsd.toFixed(2)}/mo/dev</div></div>
        <div class="kpi"><div class="kpi-label">Unignored Token Sinks</div><div class="kpi-val">${tf.tokenSinks.length} files</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Category Scorecard</h2>
      ${categoryRows}
    </div>
    <div class="card">
      <h2>Findings (${report.findings.length})</h2>
      ${findingRows}
    </div>
  </div>
</body>
</html>`;
}
