import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import {
  analyzeBlastRadius,
  formatHtmlReport,
  generatePrHandoffBrief,
  runDependencyAudit,
} from '@archpilot/core';
import type { FolderAudit } from './types.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function showBlastRadiusPicker(audit: FolderAudit): Promise<void> {
  const br = await analyzeBlastRadius(audit.rootDir);
  if (br.changedFiles.length === 0) {
    void vscode.window.showInformationMessage(`No git changes detected in ${audit.name}.`);
    return;
  }

  interface ImpactItem extends vscode.QuickPickItem {
    filePath?: string;
    generateTests?: boolean;
  }

  const items: ImpactItem[] = [
    {
      label: `$(flame) Risk: ${br.riskLevel.toUpperCase()} — ${br.changedFiles.length} changed · ${br.transitiveDependents.length} downstream · ${br.untestedImpactedFiles.length} untested`,
      kind: vscode.QuickPickItemKind.Default,
    },
  ];

  if (br.untestedImpactedFiles.length > 0) {
    items.push({
      label: `$(sparkle) Generate Missing Tests with AI Chat (${br.untestedImpactedFiles.length} untested files)`,
      description: 'Opens AI Chat with targeted test-generation prompt',
      generateTests: true,
    });
  }

  items.push(
    { label: 'Changed Files', kind: vscode.QuickPickItemKind.Separator },
    ...br.changedFiles.map((f) => ({
      label: `$(edit) ${f}`,
      description: 'changed',
      filePath: f,
    }))
  );

  if (br.impactedTestsToRun.length > 0) {
    items.push(
      { label: 'Recommended Tests to Run (QA)', kind: vscode.QuickPickItemKind.Separator },
      ...br.impactedTestsToRun.map((f) => ({
        label: `$(beaker) ${f}`,
        description: 'affected test suite',
        filePath: f,
      }))
    );
  }

  if (br.untestedImpactedFiles.length > 0) {
    items.push(
      { label: 'Untested Impacted Files (QA Gap)', kind: vscode.QuickPickItemKind.Separator },
      ...br.untestedImpactedFiles.map((f) => ({
        label: `$(warning) ${f}`,
        description: 'no matching unit test found',
        filePath: f,
      }))
    );
  }

  if (br.transitiveDependents.length > 0) {
    items.push(
      { label: 'Downstream Impacted Files', kind: vscode.QuickPickItemKind.Separator },
      ...br.transitiveDependents.map((f) => ({
        label: `$(arrow-right) ${f}`,
        description: br.directDependents.includes(f) ? 'direct dependent' : 'transitive dependent',
        filePath: f,
      }))
    );
  }

  if (br.diffFindings.length > 0) {
    items.push(
      { label: 'Guardrail Findings in Changed Files', kind: vscode.QuickPickItemKind.Separator },
      ...br.diffFindings.map((f) => ({
        label: `$(warning) [${f.id}] ${f.message}`,
        description: f.file,
        filePath: f.file,
      }))
    );
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `ArchPilot Blast Radius & QA Test Gaps — ${audit.name}`,
    placeHolder: 'Select any file to open, or generate missing tests with AI Chat',
  });

  if (picked?.generateTests) {
    const prompt = [
      `Please write focused unit tests for these changed/impacted files in **${audit.name}** that currently have no matching test coverage:`,
      '',
      ...br.untestedImpactedFiles.slice(0, 15).map((f) => `- \`${f}\``),
      '',
      'Use deterministic assertions (no hardcoded sleeps/timeouts) and verify all tests pass.',
    ].join('\n');
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage('Copied test-generation prompt to clipboard.');
    }
    return;
  }

  if (picked?.filePath) {
    const absPath = path.join(audit.rootDir, picked.filePath);
    if (await fileExists(absPath)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath));
    } else {
      void vscode.window.showInformationMessage(
        `"${picked.filePath}" no longer exists on disk (deleted or moved in Git).`
      );
    }
  }
}

export async function exportExecutiveHtmlReport(audit: FolderAudit): Promise<void> {
  const defaultUri = vscode.Uri.file(path.join(audit.rootDir, 'archpilot-report.html'));
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { 'HTML Report': ['html'] },
    title: 'Export ArchPilot Executive Audit Report',
  });
  if (!saveUri) return;

  const html = formatHtmlReport(audit.report);
  await writeFile(saveUri.fsPath, html, 'utf8');
  const choice = await vscode.window.showInformationMessage(
    `Exported ArchPilot Executive Report to ${path.basename(saveUri.fsPath)}.`,
    'Open in Browser'
  );
  if (choice === 'Open in Browser') {
    await vscode.env.openExternal(saveUri);
  }
}

export async function generateAndCopyPrBrief(audit: FolderAudit): Promise<void> {
  const brief = await generatePrHandoffBrief(audit.rootDir);
  await vscode.env.clipboard.writeText(brief);

  const action = await vscode.window.showInformationMessage(
    `Copied PR & QA Handoff Brief for ${audit.name} to clipboard — ready to paste into GitHub, GitLab, Bitbucket, or Jira.`,
    'Open Preview'
  );
  if (action === 'Open Preview') {
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: brief,
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  }
}

export async function runDependencyAuditPicker(audit: FolderAudit): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('archpilot');
  const npmRegistry = cfg.get<string>('npmAuditRegistry', '').trim() || undefined;

  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ArchPilot: Auditing dependency CVEs for ${audit.name}...`,
      cancellable: false,
    },
    () => runDependencyAudit(audit.rootDir, { npmRegistry })
  );

  if (report.vulnerabilities.length === 0) {
    const extra = report.notes.length > 0 ? ` (${report.notes[0]})` : '';
    void vscode.window.showInformationMessage(
      `ArchPilot CVE Audit: 0 known dependency vulnerabilities in ${audit.name}${extra}`
    );
    return;
  }

  interface VulnItem extends vscode.QuickPickItem {
    action?: 'npmFix' | 'aiChat' | 'openUrl';
    url?: string;
  }

  const hasSafeNpmFix = report.vulnerabilities.some(
    (v) => v.ecosystem === 'npm' && v.fixAvailable && !v.isBreakingFix
  );
  const registryFlag = report.registryUsed ? ` --registry=${report.registryUsed}` : '';

  const items: VulnItem[] = [
    {
      label: `$(shield) ${report.counts.total} CVEs — ${report.counts.critical} Critical · ${report.counts.high} High · ${report.counts.moderate} Moderate · ${report.counts.low} Low`,
      description: report.usedPublicFallback ? 'via public registry.npmjs.org fallback' : report.registryUsed ?? 'default registry',
    },
  ];

  if (hasSafeNpmFix) {
    items.push({
      label: '$(wrench) Run Safe `npm audit fix` in Terminal',
      description: 'Applies non-breaking security patches automatically',
      action: 'npmFix',
    });
  }

  items.push({
    label: '$(sparkle) Fix All / Breaking CVEs with AI Chat',
    description: 'Opens AI Chat with exact vulnerable packages & target versions',
    action: 'aiChat',
  });

  items.push({ label: 'Vulnerable Packages', kind: vscode.QuickPickItemKind.Separator });
  for (const v of report.vulnerabilities) {
    const icon =
      v.severity === 'critical' || v.severity === 'high' ? '$(error)' : '$(warning)';
    const fixNote = v.fixAvailable
      ? v.isBreakingFix
        ? `breaking fix${v.fixedVersion ? ` -> ${v.fixedVersion}` : ''}`
        : `safe fix${v.fixedVersion ? ` -> ${v.fixedVersion}` : ''}`
      : 'no auto-fix';
    items.push({
      label: `${icon} [${v.severity.toUpperCase()}] ${v.packageName}`,
      description: `${fixNote} · ${v.title}`,
      action: v.url ? 'openUrl' : undefined,
      url: v.url,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `ArchPilot Dependency CVE Audit — ${audit.name}`,
    placeHolder: 'Choose a remediation action or click a CVE to open its advisory',
  });

  if (picked?.action === 'npmFix') {
    const term = vscode.window.createTerminal({
      name: `ArchPilot: npm audit fix (${audit.name})`,
      cwd: audit.rootDir,
    });
    term.show();
    term.sendText(`npm audit fix${registryFlag}`);
  } else if (picked?.action === 'aiChat') {
    const prompt = [
      `Please remediate these dependency security vulnerabilities (CVEs) in **${audit.name}** safely (update versions, adjust any breaking API changes, and verify build & tests pass):`,
      '',
      ...report.vulnerabilities.slice(0, 20).map(
        (v) =>
          `- **[${v.severity.toUpperCase()}] \`${v.packageName}\`** (${v.ecosystem}): ${v.title}${v.fixedVersion ? ` — target version \`${v.fixedVersion}\`${v.isBreakingFix ? ' (major/breaking)' : ''}` : ''}`
      ),
    ].join('\n');
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage('Copied CVE remediation prompt to clipboard.');
    }
  } else if (picked?.action === 'openUrl' && picked.url) {
    await vscode.env.openExternal(vscode.Uri.parse(picked.url));
  }
}
