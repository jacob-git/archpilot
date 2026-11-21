#!/usr/bin/env node
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeBlastRadius,
  analyzeMigration,
  auditRepository,
  buildArchitectureDiagram,
  formatHtmlReport,
  formatMarkdown,
  formatSarif,
  generateAgentsMd,
  generateArchitectureMd,
  generateArchMap,
  generateMermaidDiagram,
  generateMigrationPlanMd,
  generatePrHandoffBrief,
  generateSmartArchPilotConfig,
  runDependencyAudit,
  type AuditReport,
  type MigrationPlaybookId,
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
  let format: 'text' | 'json' | 'sarif' | 'markdown' | 'html' = 'text';
  let initMode = false;
  let mapMode = false;
  let diagramMode = false;
  let archMdMode = false;
  let prBriefMode = false;
  let depAuditMode = false;
  let npmRegistry: string | undefined;
  let migratePlaybook: MigrationPlaybookId | undefined;
  let writeMigrateMd = false;
  let diffMode = false;
  let failUnder: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      format = 'json';
    } else if (arg === '--format') {
      const next = args[++i];
      if (
        next === 'text' ||
        next === 'json' ||
        next === 'sarif' ||
        next === 'markdown' ||
        next === 'html'
      ) {
        format = next;
      }
    } else if (arg === '--init') {
      initMode = true;
    } else if (arg === '--map') {
      mapMode = true;
    } else if (arg === '--diagram') {
      diagramMode = true;
    } else if (arg === '--arch-md') {
      archMdMode = true;
    } else if (arg === '--pr-brief') {
      prBriefMode = true;
    } else if (arg === '--dep-audit') {
      depAuditMode = true;
    } else if (arg === '--registry') {
      npmRegistry = args[++i];
    } else if (arg === '--migrate' || arg === '--migrate-md') {
      migratePlaybook = (args[++i] ?? 'webpack-to-vite') as MigrationPlaybookId;
      if (arg === '--migrate-md') writeMigrateMd = true;
    } else if (arg === '--diff') {
      diffMode = true;
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
  --init                       Generate starter AGENTS.md and smart archpilot.json
  --map                        Generate compact ARCHMAP.md repo index to save agent tokens
  --diagram                    Output living Mermaid architecture diagram (modules + external systems)
  --arch-md                    Generate ARCHITECTURE.md with living Mermaid diagram
  --pr-brief                   Generate ready-to-paste PR & QA Handoff Brief (Markdown)
  --dep-audit                  Audit dependency CVEs (auto-falls back to public npmjs.org)
  --registry <url>             Optional npm registry URL for --dep-audit
  --migrate <playbook>         Scan upgrade blockers (webpack-to-vite | spring-boot-3-to-4 | cjs-to-esm | react-18-to-19 | pydantic-v1-to-v2)
  --migrate-md <playbook>      Generate dependency-ordered MIGRATION_PLAN.md
  --diff                       Analyze git changed files, blast radius, and QA test gaps
  --format <fmt>               Output format: text | json | sarif | markdown | html (default: text)
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
  if (diagramMode) {
    const diagramData = await buildArchitectureDiagram(resolved);
    console.log(generateMermaidDiagram(diagramData));
    return;
  }
  if (archMdMode) {
    const md = await generateArchitectureMd(resolved);
    await writeFile(path.join(resolved, 'ARCHITECTURE.md'), md, 'utf8');
    console.log(`${GREEN}Generated ARCHITECTURE.md with live Mermaid diagram${RESET}`);
    return;
  }
  if (prBriefMode) {
    console.log(await generatePrHandoffBrief(resolved));
    return;
  }
  if (depAuditMode) {
    const depReport = await runDependencyAudit(resolved, { npmRegistry });
    if (format === 'json') {
      console.log(JSON.stringify(depReport, null, 2));
    } else {
      console.log('');
      console.log(`${BOLD}ArchPilot Dependency CVE Audit${RESET}  ${DIM}${depReport.rootDir}${RESET}`);
      console.log(
        `Total CVEs: ${depReport.counts.total} (${RED}${depReport.counts.critical} critical${RESET}, ${RED}${depReport.counts.high} high${RESET}, ${YELLOW}${depReport.counts.moderate} moderate${RESET}, ${CYAN}${depReport.counts.low} low${RESET})`
      );
      for (const note of depReport.notes) console.log(`${DIM}${note}${RESET}`);
      for (const v of depReport.vulnerabilities) {
        const fix = v.fixAvailable
          ? v.isBreakingFix
            ? `breaking fix -> ${v.fixedVersion ?? 'major'}`
            : `safe fix -> ${v.fixedVersion ?? 'available'}`
          : 'no auto-fix';
        console.log(`  [${v.severity.toUpperCase()}] ${v.packageName} (${fix}): ${v.title}`);
      }
      console.log('');
    }
    if (depReport.counts.critical > 0 || depReport.counts.high > 0) {
      process.exitCode = 1;
    }
    return;
  }
  if (migratePlaybook) {
    const plan = await analyzeMigration(resolved, { playbookId: migratePlaybook });
    if (writeMigrateMd) {
      const target = path.join(resolved, 'MIGRATION_PLAN.md');
      await writeFile(target, generateMigrationPlanMd(plan), 'utf8');
      console.log(`Created ${target} (${plan.totalBlockers} blockers across ${plan.impactedFileCount} files).`);
      return;
    }
    if (format === 'json') {
      console.log(JSON.stringify(plan, null, 2));
    } else if (format === 'markdown') {
      console.log(generateMigrationPlanMd(plan));
    } else {
      console.log('');
      console.log(`${BOLD}ArchPilot Migration Readiness: ${plan.name}${RESET}  ${DIM}${plan.rootDir}${RESET}`);
      console.log(
        `Blockers: ${plan.totalBlockers === 0 ? GREEN : YELLOW}${BOLD}${plan.totalBlockers}${RESET} across ${plan.impactedFileCount} files (effort: ${plan.estimatedEffort.toUpperCase()})`
      );
      for (const wave of plan.waves) {
        console.log(`\n${BOLD}${wave.label}${RESET} ${DIM}(${wave.files.length} files)${RESET}`);
        for (const f of wave.files.slice(0, 15)) {
          console.log(`  • ${f.file} (${f.blockerCount} blockers, ${f.dependentCount} dependents)`);
        }
      }
      console.log('');
    }
    return;
  }
  if (diffMode) {
    const br = await analyzeBlastRadius(resolved);
    if (format === 'json') {
      console.log(JSON.stringify(br, null, 2));
    } else {
      const riskColor = br.riskLevel === 'high' ? RED : br.riskLevel === 'medium' ? YELLOW : GREEN;
      console.log('');
      console.log(`${BOLD}ArchPilot Diff & Blast Radius${RESET}  ${DIM}${br.rootDir}${RESET}`);
      console.log(
        `Risk: ${riskColor}${BOLD}${br.riskLevel.toUpperCase()}${RESET} · ${br.changedFiles.length} changed · ${br.transitiveDependents.length} downstream impacted · ${br.impactedModules.length} modules`
      );
      if (br.changedFiles.length > 0) {
        console.log(`\n${BOLD}Changed Files:${RESET}`);
        for (const f of br.changedFiles.slice(0, 20)) console.log(`  • ${f}`);
      }
      if (br.transitiveDependents.length > 0) {
        console.log(`\n${BOLD}Downstream Impacted Files:${RESET}`);
        for (const f of br.transitiveDependents.slice(0, 20)) console.log(`  → ${f}`);
      }
      if (br.impactedTestsToRun.length > 0) {
        console.log(`\n${BOLD}Recommended Tests to Run:${RESET}`);
        for (const f of br.impactedTestsToRun.slice(0, 20)) console.log(`  ✔ ${f}`);
      }
      if (br.untestedImpactedFiles.length > 0) {
        console.log(`\n${YELLOW}${BOLD}Untested Impacted Files (QA Gap):${RESET}`);
        for (const f of br.untestedImpactedFiles.slice(0, 20)) console.log(`  ⚠ ${f}`);
      }
      if (br.diffFindings.length > 0) {
        console.log(`\n${BOLD}Findings in Changed Files:${RESET}`);
        for (const f of br.diffFindings) {
          console.log(`  ${severityTag(f.severity)} [${f.id}] ${DIM}${f.file ?? ''}${RESET}: ${f.message}`);
        }
      }
      console.log('');
    }
    if (br.diffFindings.some((f) => f.severity === 'error')) {
      process.exitCode = 1;
    }
    return;
  }

  const report = await auditRepository(resolved);
  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else if (format === 'sarif') {
    console.log(formatSarif(report));
  } else if (format === 'markdown') {
    console.log(formatMarkdown(report));
  } else if (format === 'html') {
    console.log(formatHtmlReport(report));
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
