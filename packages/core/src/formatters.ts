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
