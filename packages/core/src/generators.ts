import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scanWorkspace } from './scanner.js';
import { DEFAULT_CONFIG } from './config.js';
import type { AuditReport, Finding } from './types.js';

export async function generateAgentsMd(rootDir: string): Promise<string> {
  const repoName = path.basename(path.resolve(rootDir));
  const files = await scanWorkspace(rootDir, DEFAULT_CONFIG.ignore);

  let scriptsSection = '- Add your build, test, and lint commands here.';
  try {
    const rawPkg = await readFile(path.join(rootDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(rawPkg) as { scripts?: Record<string, string> };
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      scriptsSection = Object.entries(pkg.scripts)
        .map(([name, cmd]) => `- \`npm run ${name}\` — \`${cmd}\``)
        .join('\n');
    }
  } catch {
    // non-Node repo
  }

  const topDirs = Array.from(
    new Set(
      files
        .map((f) => f.relPath.split('/')[0])
        .filter((seg) => !seg.startsWith('.') && files.some((f) => f.relPath.startsWith(`${seg}/`)))
    )
  ).sort();

  const layoutSection =
    topDirs.length > 0
      ? topDirs.map((d) => `- \`${d}/\` — TODO: describe module responsibility`).join('\n')
      : '- Describe your primary source directories here.';

  return `# AGENTS.md — ${repoName}

## Overview
Concise engineering guide for AI coding agents working in **${repoName}**.

## Commands
${scriptsSection}

## Repository Layout
${layoutSection}

## Architecture Guardrails
- Follow module boundaries defined in \`archpilot.json\`.
- Keep files focused and modular (avoid mega-files > ${DEFAULT_CONFIG.maxFileLines} lines).
- Always run tests and typechecks before finishing a task.
`;
}

export function generateArchPilotConfig(): string {
  return (
    JSON.stringify(
      {
        maxFileLines: 800,
        ignore: ['node_modules', 'dist', 'build', 'coverage'],
        boundaries: [
          {
            name: 'example-layer-boundary',
            from: 'src/domain',
            disallow: ['src/ui', 'src/infra'],
            message: 'Domain layer must not depend on UI or infrastructure.',
          },
        ],
      },
      null,
      2
    ) + '\n'
  );
}

export function generateGitignore(): string {
  return `node_modules/
dist/
build/
out/
coverage/
.env
.env.local
.DS_Store
*.log
`;
}

export function generateReadmeBadge(report: AuditReport): string {
  const color =
    report.overallScore >= 90
      ? 'brightgreen'
      : report.overallScore >= 80
        ? 'green'
        : report.overallScore >= 70
          ? 'yellow'
          : report.overallScore >= 60
            ? 'orange'
            : 'red';
  const label = encodeURIComponent(`${report.overallScore}/100 (${report.grade})`);
  return `[![ArchPilot Score](https://img.shields.io/badge/ArchPilot-${label}-${color})](https://github.com/jacob-git/archpilot)`;
}

export function generateFixPrompt(report: AuditReport, singleFinding?: Finding): string {
  const repoName = path.basename(report.rootDir);
  const targets = singleFinding ? [singleFinding] : report.findings;

  if (targets.length === 0) {
    return `ArchPilot reported 0 issues for ${repoName} (${report.overallScore}/100, Grade ${report.grade}).`;
  }

  const lines = [
    `Please fix the following ArchPilot architecture & AI-readiness issue${targets.length > 1 ? 's' : ''} in **${repoName}**:`,
    '',
  ];

  for (const f of targets) {
    const loc = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : '';
    lines.push(`- **[${f.severity.toUpperCase()}] \`${f.id}\`**${loc}: ${f.message}`);
    if (f.suggestion) {
      lines.push(`  - Suggested fix: ${f.suggestion}`);
    }
  }

  lines.push(
    '',
    'After making changes, verify that tests and typechecks pass and re-run `archpilot` to confirm the issues are resolved.'
  );

  return lines.join('\n');
}
