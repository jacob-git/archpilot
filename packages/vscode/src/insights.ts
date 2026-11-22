import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import {
  analyzeTokenBreakdown,
  BASELINE_FILENAME,
  compareAgainstBaseline,
  findOrphanFiles,
  findUnusedDependencies,
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

export async function showTokenBreakdownPicker(audit: FolderAudit): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('archpilot');
  const rate = cfg.get<number>('costPerMillionInputTokens', 3);

  const res = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ArchPilot: Analyzing token breakdown for ${audit.name}...`,
      cancellable: false,
    },
    () => analyzeTokenBreakdown(audit.rootDir, rate)
  );

  interface BreakdownPick extends vscode.QuickPickItem {
    kindType?: 'folder' | 'file';
    relPath?: string;
    tokens?: number;
  }

  const items: BreakdownPick[] = [
    {
      label: `Top Folders (~${res.totalTokens.toLocaleString('en-US')} total tokens · ~$${res.fullReadCostUsd.toFixed(3)}/full read at $${rate}/1M)`,
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...res.topFolders.map((f) => ({
      label: `$(folder) ${f.folder}`,
      description: `~${f.estimatedTokens.toLocaleString('en-US')} tok (${f.percentOfRepo}%) · ~$${f.costPerReadUsd.toFixed(4)}/read`,
      detail: `${f.fileCount} file${f.fileCount === 1 ? '' : 's'} (click to exclude folder in .aiignore)`,
      kindType: 'folder' as const,
      relPath: f.folder === '(root)' ? undefined : f.folder,
      tokens: f.estimatedTokens,
    })),
    {
      label: 'Top Heaviest Files',
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...res.topFiles.map((f) => ({
      label: `$(file-code) ${f.file}`,
      description: `~${f.estimatedTokens.toLocaleString('en-US')} tok · ~$${f.costPerReadUsd.toFixed(4)}/read`,
      kindType: 'file' as const,
      relPath: f.file,
      tokens: f.estimatedTokens,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Token Breakdown: ${audit.name}`,
    placeHolder: 'Select a folder or file to exclude in .aiignore or open',
  });
  if (!picked || !picked.relPath) return false;

  if (picked.kindType === 'folder') {
    const confirm = await vscode.window.showInformationMessage(
      `Exclude folder "${picked.relPath}/" (~${(picked.tokens ?? 0).toLocaleString('en-US')} tokens) in .aiignore & .cursorignore?`,
      'Exclude Folder'
    );
    if (confirm === 'Exclude Folder') {
      const entry = `${picked.relPath}/`;
      await appendToIgnoreFile(path.join(audit.rootDir, '.aiignore'), [entry]);
      await appendToIgnoreFile(path.join(audit.rootDir, '.cursorignore'), [entry]);
      void vscode.window.showInformationMessage(`Excluded "${entry}" in .aiignore & .cursorignore.`);
      return true;
    }
    return false;
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(filter) Exclude in .aiignore & .cursorignore', action: 'ignore' as const },
      { label: '$(go-to-file) Open File', action: 'open' as const },
    ],
    { placeHolder: `Action for ${picked.relPath}` }
  );
  if (action?.action === 'ignore') {
    await appendToIgnoreFile(path.join(audit.rootDir, '.aiignore'), [picked.relPath]);
    await appendToIgnoreFile(path.join(audit.rootDir, '.cursorignore'), [picked.relPath]);
    void vscode.window.showInformationMessage(
      `Excluded "${picked.relPath}" in .aiignore & .cursorignore.`
    );
    return true;
  }
  if (action?.action === 'open') {
    const full = path.join(audit.rootDir, picked.relPath);
    if (await fileExists(full)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full));
    }
  }
  return false;
}

export async function showUnusedDepsPicker(audit: FolderAudit): Promise<void> {
  const res = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ArchPilot: Scanning ${audit.name} for unused dependencies...`,
      cancellable: false,
    },
    () => findUnusedDependencies(audit.rootDir)
  );

  if (res.totalDependencies === 0) {
    void vscode.window.showInformationMessage(`No package.json runtime dependencies found in ${audit.name}.`);
    return;
  }

  if (res.unused.length === 0) {
    void vscode.window.showInformationMessage(
      `All ${res.totalDependencies} runtime dependencies in ${audit.name} are referenced.`
    );
    return;
  }

  interface DepPick extends vscode.QuickPickItem {
    action?: 'uninstallRoot' | 'aiChat' | 'openPkg';
    pkgPath?: string;
  }

  const rootUnused = res.unused.filter((u) => u.packageJsonPath === 'package.json').map((u) => u.name);
  const items: DepPick[] = [];

  if (rootUnused.length > 0) {
    items.push({
      label: `$(terminal) Run npm uninstall (${rootUnused.length} root package${rootUnused.length === 1 ? '' : 's'})`,
      description: rootUnused.slice(0, 4).join(', ') + (rootUnused.length > 4 ? '...' : ''),
      action: 'uninstallRoot',
    });
  }

  items.push(
    {
      label: '$(comment-discussion) Review & Remove Unused Dependencies with AI Chat',
      description: `${res.unused.length} candidate${res.unused.length === 1 ? '' : 's'}`,
      action: 'aiChat',
    },
    {
      label: `Unused Runtime Dependencies (${res.unused.length} of ${res.totalDependencies})`,
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...res.unused.map((u) => ({
      label: `$(package) ${u.name}`,
      description: `${u.version} · ${u.packageJsonPath}`,
      action: 'openPkg' as const,
      pkgPath: u.packageJsonPath,
    }))
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: `Unused Dependencies in ${audit.name}`,
    placeHolder: 'Uninstall, review with AI Chat, or open package.json',
  });
  if (!picked) return;

  if (picked.action === 'uninstallRoot' && rootUnused.length > 0) {
    const term = vscode.window.createTerminal({
      name: `ArchPilot: npm uninstall (${audit.name})`,
      cwd: audit.rootDir,
    });
    term.show();
    term.sendText(`npm uninstall ${rootUnused.join(' ')}`);
  } else if (picked.action === 'aiChat') {
    const prompt = [
      `ArchPilot detected ${res.unused.length} runtime dependencies in **${audit.name}** that are not directly imported in source files.`,
      'Please verify whether any are needed implicitly (peer/plugin/CLI runtime) and safely remove the truly unused ones:',
      '',
      ...res.unused.map((u) => `- \`${u.name}\` (${u.version}) in \`${u.packageJsonPath}\``),
    ].join('\n');
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage('Copied unused dependencies prompt to clipboard.');
    }
  } else if (picked.action === 'openPkg' && picked.pkgPath) {
    const full = path.join(audit.rootDir, picked.pkgPath);
    if (await fileExists(full)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full));
    }
  }
}
