import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import {
  BASELINE_FILENAME,
  compareAgainstBaseline,
  findOrphanFiles,
  saveArchitectureBaseline,
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

async function appendToIgnoreFile(filePath: string, entries: string[]): Promise<number> {
  const existing = (await fileExists(filePath)) ? await readFile(filePath, 'utf8') : '';
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  );
  const toAdd = entries.filter((e) => !existingLines.has(e));
  if (toAdd.length === 0) return 0;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(filePath, `${existing}${prefix}${toAdd.join('\n')}\n`, 'utf8');
  return toAdd.length;
}

export async function showOrphanFilesPicker(audit: FolderAudit): Promise<boolean> {
  const res = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ArchPilot: Scanning ${audit.name} for orphan / dead files...`,
      cancellable: false,
    },
    () => findOrphanFiles(audit.rootDir)
  );

  if (res.orphans.length === 0) {
    void vscode.window.showInformationMessage(
      `No unreachable orphan source files found in ${audit.name} (${res.totalCodeFiles} code files checked).`
    );
    return false;
  }

  interface OrphanPick extends vscode.QuickPickItem {
    action?: 'aiIgnoreAll' | 'aiChat' | 'openFile';
    relPath?: string;
  }

  const items: OrphanPick[] = [
    {
      label: '$(filter) Exclude All Orphan Files in .aiignore & .cursorignore',
      description: `Save ~${res.totalWastedTokens.toLocaleString('en-US')} tokens`,
      detail: 'Keeps the files on disk while preventing AI agents from indexing dead code',
      action: 'aiIgnoreAll',
    },
    {
      label: '$(comment-discussion) Review & Clean Up with AI Chat',
      description: `${res.orphans.length} candidate files`,
      detail: 'Opens AI Chat to verify which files are safe to delete or wire up',
      action: 'aiChat',
    },
    {
      label: `Unreachable Source Files (${res.orphans.length})`,
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...res.orphans.slice(0, 30).map((o) => ({
      label: `$(file-code) ${o.file}`,
      description: `~${o.estimatedTokens.toLocaleString('en-US')} tokens`,
      action: 'openFile' as const,
      relPath: o.file,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Orphan / Dead Files in ${audit.name} (~${res.totalWastedTokens.toLocaleString('en-US')} tokens)`,
    placeHolder: 'Exclude in .aiignore, review with AI Chat, or open a file',
  });
  if (!picked) return false;

  if (picked.action === 'aiIgnoreAll') {
    const entries = res.orphans.map((o) => o.file);
    const added = await appendToIgnoreFile(path.join(audit.rootDir, '.aiignore'), entries);
    await appendToIgnoreFile(path.join(audit.rootDir, '.cursorignore'), entries);
    void vscode.window.showInformationMessage(
      `Excluded ${added} orphan file${added === 1 ? '' : 's'} in .aiignore & .cursorignore (~${res.totalWastedTokens.toLocaleString('en-US')} tokens saved).`
    );
    return added > 0;
  }

  if (picked.action === 'aiChat') {
    const prompt = [
      `ArchPilot found ${res.orphans.length} source files in **${audit.name}** with 0 incoming imports (~${res.totalWastedTokens.toLocaleString('en-US')} tokens).`,
      'Please verify whether each file is truly dead code (not dynamically imported or referenced by build config) and help me safely delete unused ones:',
      '',
      ...res.orphans.slice(0, 25).map((o) => `- \`${o.file}\` (~${o.estimatedTokens} tokens)`),
    ].join('\n');
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage('Copied orphan file cleanup prompt to clipboard.');
    }
    return false;
  }

  if (picked.action === 'openFile' && picked.relPath) {
    const full = path.join(audit.rootDir, picked.relPath);
    if (await fileExists(full)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full));
    }
  }
  return false;
}

export async function showBaselineComparisonPicker(audit: FolderAudit): Promise<void> {
  const diff = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ArchPilot: Comparing ${audit.name} against architecture baseline...`,
      cancellable: false,
    },
    () => compareAgainstBaseline(audit.rootDir)
  );

  if (!diff.hasBaseline) {
    const choice = await vscode.window.showInformationMessage(
      `No ${BASELINE_FILENAME} found in ${audit.name}. Save a baseline snapshot now before starting a refactor or upgrade?`,
      'Save Baseline Snapshot'
    );
    if (choice === 'Save Baseline Snapshot') {
      const { baseline } = await saveArchitectureBaseline(audit.rootDir);
      void vscode.window.showInformationMessage(
        `Saved ${BASELINE_FILENAME} (Score ${baseline.overallScore}/100, ${baseline.moduleCount} modules, ${baseline.findingSignatures.length} findings).`
      );
    }
    return;
  }

  interface BaselinePick extends vscode.QuickPickItem {
    action?: 'updateBaseline' | 'aiRegressions' | 'openFile';
    relPath?: string;
    line?: number;
  }

  const scoreStr = `${diff.baselineScore} -> ${diff.currentScore} (${diff.scoreDelta >= 0 ? '+' : ''}${diff.scoreDelta})`;
  const tokenStr = `${diff.tokenDelta >= 0 ? '+' : ''}${diff.tokenDelta.toLocaleString('en-US')} tokens`;

  const items: BaselinePick[] = [
    {
      label: '$(save) Update / Overwrite Architecture Baseline',
      description: `Current: ${scoreStr} · ${tokenStr}`,
      detail: `Last saved: ${diff.baselineCreatedAt ?? 'unknown'}`,
      action: 'updateBaseline',
    },
  ];

  if (diff.newFindings.length > 0) {
    items.push({
      label: '$(comment-discussion) Fix New Regressions with AI Chat',
      description: `${diff.newFindings.length} new issue${diff.newFindings.length === 1 ? '' : 's'} since baseline`,
      action: 'aiRegressions',
    });
    items.push({
      label: `New Regressions Since Baseline (${diff.newFindings.length})`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const f of diff.newFindings.slice(0, 20)) {
      items.push({
        label: `$(error) [${f.id}] ${f.file ?? audit.name}`,
        description: f.line ? `L${f.line}` : '',
        detail: f.message,
        action: f.file ? 'openFile' : undefined,
        relPath: f.file,
        line: f.line,
      });
    }
  }

  if (diff.newExternalSystems.length > 0 || diff.removedExternalSystems.length > 0) {
    items.push({ label: 'External System Changes', kind: vscode.QuickPickItemKind.Separator });
    for (const s of diff.newExternalSystems) {
      items.push({ label: `$(add) Added external system: ${s}` });
    }
    for (const s of diff.removedExternalSystems) {
      items.push({ label: `$(remove) Removed external system: ${s}` });
    }
  }

  if (diff.resolvedSignatures.length > 0) {
    items.push({
      label: `$(check) ${diff.resolvedSignatures.length} issue${diff.resolvedSignatures.length === 1 ? '' : 's'} resolved since baseline`,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Baseline Diff (${diff.status.toUpperCase()}): ${audit.name} · Score ${scoreStr}`,
    placeHolder: 'Inspect regressions, fix with AI Chat, or update the baseline',
  });
  if (!picked) return;

  if (picked.action === 'updateBaseline') {
    const { baseline } = await saveArchitectureBaseline(audit.rootDir);
    void vscode.window.showInformationMessage(
      `Updated ${BASELINE_FILENAME} (Score ${baseline.overallScore}/100, ${baseline.findingSignatures.length} findings).`
    );
  } else if (picked.action === 'aiRegressions') {
    const prompt = [
      `Please fix these ${diff.newFindings.length} architecture/security regressions introduced in **${audit.name}** since the saved baseline:`,
      '',
      ...diff.newFindings
        .slice(0, 20)
        .map(
          (f) =>
            `- **[${f.id}]** ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.message}${f.suggestion ? ` Fix: ${f.suggestion}` : ''}`
        ),
    ].join('\n');
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage('Copied baseline regression fix prompt to clipboard.');
    }
  } else if (picked.action === 'openFile' && picked.relPath) {
    const full = path.join(audit.rootDir, picked.relPath);
    if (await fileExists(full)) {
      const doc = await vscode.workspace.openTextDocument(full);
      const editor = await vscode.window.showTextDocument(doc);
      if (picked.line && picked.line > 0) {
        const pos = new vscode.Position(picked.line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
  }
}
