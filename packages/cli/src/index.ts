#!/usr/bin/env node
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  auditRepository,
  formatMarkdown,
  formatSarif,
  generateAgentsMd,
  generateArchMap,
  generateSmartArchPilotConfig,
  type AuditReport,
  type Severity,
} from '@archpilot/core';
import { runMcpServer } from './mcp.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

function colorForScore(score: number): string {
  if (score >= 85) return GREEN;
  if (score >= 65) return YELLOW;
  return RED;
}

function severityTag(sev: Severity): string {
  if (sev === 'error') return `${RED}ERROR${RESET}`;
  if (sev === 'warning') return `${YELLOW}WARN ${RESET}`;
  return `${CYAN}INFO ${RESET}`;
}

function renderBar(score: number): string {
  const filled = Math.round(score / 5);
  return `${colorForScore(score)}${'█'.repeat(filled)}${DIM}${'░'.repeat(20 - filled)}${RESET}`;
}

function printReport(report: AuditReport): void {
  const scoreColor = colorForScore(report.overallScore);
  console.log('');
  console.log(`${BOLD}ArchPilot Report${RESET}  ${DIM}${report.rootDir}${RESET}`);
  console.log(
    `Overall Score: ${scoreColor}${BOLD}${report.overallScore}/100 (Grade ${report.grade})${RESET}  ${DIM}(${report.summary.filesScanned} files in ${report.summary.durationMs}ms)${RESET}`
  );
  const stackTags = [
    ...report.detectedStack.languages,
    ...report.detectedStack.frameworks,
    ...report.detectedStack.capabilities,
  ];
  if (stackTags.length > 0) {
    console.log(`${DIM}Detected Stack: ${stackTags.join(' · ')}${RESET}`);
  }
  const tf = report.tokenFootprint;
  const c = tf.costEstimate;
  const savingsPart =
    c.potentialMonthlySavingsUsd > 0
      ? ` · ${GREEN}Save ~$${c.potentialMonthlySavingsUsd.toFixed(2)}/mo/dev${RESET}`
      : '';
  console.log(
    `${DIM}Token Cost (${c.modelLabel}): ~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} tok/turn (~$${c.alwaysOnMonthlyUsd.toFixed(2)}/mo) · ${tf.tokenSinks.length} sinks (~$${c.sinkMonthlyRiskUsd.toFixed(2)}/mo risk)${RESET}${savingsPart}`
  );
  console.log('');

  for (const cat of report.categories) {
    const label = cat.label.padEnd(28);
    console.log(`  ${label} ${renderBar(cat.score)} ${BOLD}${String(cat.score).padStart(3)}/100${RESET}`);
  }

  console.log('');
  if (report.findings.length === 0) {
    console.log(`${GREEN}${BOLD}No issues found. Your repo is ready for AI coding agents.${RESET}`);
    console.log('');
    return;
  }

  console.log(
    `${BOLD}Findings${RESET} (${RED}${report.summary.errors} errors${RESET}, ${YELLOW}${report.summary.warnings} warnings${RESET}, ${CYAN}${report.summary.infos} info${RESET}):`
  );
  for (const f of report.findings) {
    const loc = f.file ? ` ${DIM}${f.file}${f.line ? `:${f.line}` : ''}${RESET}` : '';
    console.log(`  ${severityTag(f.severity)} [${f.id}]${loc}`);
    console.log(`        ${f.message}`);
    if (f.suggestion) {
      console.log(`        ${DIM}Fix: ${f.suggestion}${RESET}`);
    }
  }
  console.log('');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runInit(targetDir: string): Promise<void> {
  const agentsPath = path.join(targetDir, 'AGENTS.md');
  const configPath = path.join(targetDir, 'archpilot.json');

  if (await fileExists(agentsPath)) {
    console.log(`${DIM}Skipped AGENTS.md (already exists)${RESET}`);
  } else {
    const content = await generateAgentsMd(targetDir);
    await writeFile(agentsPath, content, 'utf8');
    console.log(`${GREEN}Created AGENTS.md${RESET}`);
  }

  if (await fileExists(configPath)) {
    console.log(`${DIM}Skipped archpilot.json (already exists)${RESET}`);
  } else {
    const configContent = await generateSmartArchPilotConfig(targetDir);
    await writeFile(configPath, configContent, 'utf8');
    console.log(`${GREEN}Created archpilot.json (auto-detected boundaries)${RESET}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'mcp') {
    await runMcpServer();
    return;
  }

  let targetDir = '.';
  let format: 'text' | 'json' | 'sarif' | 'markdown' = 'text';
  let initMode = false;
  let mapMode = false;
  let failUnder: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      format = 'json';
    } else if (arg === '--format') {
      const next = args[++i];
      if (next === 'text' || next === 'json' || next === 'sarif' || next === 'markdown') {
        format = next;
      }
    } else if (arg === '--init') {
      initMode = true;
    } else if (arg === '--map') {
      mapMode = true;
    } else if (arg === '--fail-under') {
      const next = Number(args[++i]);
      if (!Number.isNaN(next)) failUnder = next;
    } else if (arg === '-h' || arg === '--help') {
      console.log(`
Usage: archpilot [path] [options]
       archpilot mcp

Commands:
  mcp                          Start ArchPilot as an MCP stdio server for AI agents

Options:
  --init                       Generate starter AGENTS.md and archpilot.json
  --map                        Generate compact ARCHMAP.md repo index to save agent tokens
  --format <fmt>               Output format: text | json | sarif | markdown (default: text)
  --json                       Alias for --format json
  --fail-under <score>         Exit with code 1 if overall score is below <score>
  -h, --help                   Show help
`);
      return;
    } else if (!arg.startsWith('-')) {
      targetDir = arg;
    }
  }

  const resolved = path.resolve(targetDir);
  if (initMode) {
    await runInit(resolved);
    return;
  }
  if (mapMode) {
    const mapContent = await generateArchMap(resolved);
    const mapPath = path.join(resolved, 'ARCHMAP.md');
    await writeFile(mapPath, mapContent, 'utf8');
    console.log(`${GREEN}Generated ARCHMAP.md (~${Math.ceil(mapContent.length / 4)} tokens)${RESET}`);
    return;
  }

  const report = await auditRepository(resolved);
  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else if (format === 'sarif') {
    console.log(formatSarif(report));
  } else if (format === 'markdown') {
    console.log(formatMarkdown(report));
  } else {
    printReport(report);
  }

  if (report.summary.errors > 0) {
    process.exitCode = 1;
  } else if (failUnder !== undefined && report.overallScore < failUnder) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
