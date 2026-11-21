import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { analyzeBlastRadius, formatHtmlReport } from '@archpilot/core';
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
