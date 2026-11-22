import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import {
  analyzeOpenApiBreakingChanges,
  analyzeTokenBreakdown,
  BASELINE_FILENAME,
  compareAgainstBaseline,
  findOrphanFiles,
  findUnusedDependencies,
  saveArchitectureBaseline,
} from '@archpilot/core';
import type { FolderAudit } from './types.js';
import { openInspectorPanel, type InspectorSection, type InspectorViewModel } from './reportView.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function openRelFile(rootDir: string, relPath: string, line?: number): Promise<void> {
  const full = path.join(rootDir, relPath);
  if (!(await fileExists(full))) return;
  const doc = await vscode.workspace.openTextDocument(full);
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  if (line && line > 0) {
    const pos = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

async function sendToAiChat(prompt: string, label: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
  } catch {
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showInformationMessage(`Copied ${label} prompt to clipboard.`);
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

export async function showOrphanFilesPicker(
  audit: FolderAudit,
  onMutate?: () => Promise<void>
): Promise<void> {
  const buildModel = async (): Promise<{
    model: InspectorViewModel;
    res: Awaited<ReturnType<typeof findOrphanFiles>>;
  }> => {
    const res = await findOrphanFiles(audit.rootDir);
    const model: InspectorViewModel = {
      viewId: `orphans-${audit.rootDir}`,
      tabTitle: `Orphan Files: ${audit.name}`,
      heading: `Orphan / Dead Files: ${audit.name}`,
      subheading: 'Unreachable source files with 0 incoming imports',
      metrics: [
        { label: 'Orphan Files', value: String(res.orphans.length), tone: res.orphans.length > 0 ? 'warn' : 'ok' },
        { label: 'Wasted Tokens', value: `~${res.totalWastedTokens.toLocaleString('en-US')}`, tone: res.totalWastedTokens > 0 ? 'warn' : 'ok' },
        { label: 'Code Files Checked', value: String(res.totalCodeFiles) },
      ],
      headerActions:
        res.orphans.length > 0
          ? [
              { id: 'ignoreAll', label: 'Exclude All in .aiignore', primary: true },
              { id: 'aiChat', label: 'Clean Up with AI Chat' },
            ]
          : [],
      emptyMessage: `0 unreachable orphan source files found in ${audit.name}.`,
      sections: [
        {
          title: `Unreachable Source Files (${res.orphans.length})`,
          rows: res.orphans.slice(0, 40).map((o) => ({
            title: o.file,
            meta: `~${o.estimatedTokens.toLocaleString('en-US')} tokens`,
            actions: [
              { id: 'open', label: 'Open', payload: o.file },
              { id: 'ignoreOne', label: 'Exclude', payload: o.file },
            ],
          })),
        },
      ],
    };
    return { model, res };
  };

  let state = await buildModel();
  openInspectorPanel(state.model, async (actionId, payload) => {
    if (actionId === 'ignoreAll') {
      const entries = state.res.orphans.map((o) => o.file);
      const added = await appendToIgnoreFile(path.join(audit.rootDir, '.aiignore'), entries);
      await appendToIgnoreFile(path.join(audit.rootDir, '.cursorignore'), entries);
      void vscode.window.showInformationMessage(`Excluded ${added} orphan files in .aiignore & .cursorignore.`);
      if (onMutate) await onMutate();
      state = await buildModel();
      return state.model;
    }
    if (actionId === 'ignoreOne' && payload) {
      await appendToIgnoreFile(path.join(audit.rootDir, '.aiignore'), [payload]);
      await appendToIgnoreFile(path.join(audit.rootDir, '.cursorignore'), [payload]);
      if (onMutate) await onMutate();
      state = await buildModel();
      return state.model;
    }
    if (actionId === 'aiChat') {
      const prompt = [
        `ArchPilot found ${state.res.orphans.length} source files in **${audit.name}** with 0 incoming imports (~${state.res.totalWastedTokens.toLocaleString('en-US')} tokens).`,
        'Please verify whether each file is truly dead code and help me safely delete unused ones:',
        '',
        ...state.res.orphans.slice(0, 25).map((o) => `- \`${o.file}\` (~${o.estimatedTokens} tokens)`),
      ].join('\n');
      await sendToAiChat(prompt, 'orphan cleanup');
    } else if (actionId === 'open' && payload) {
      await openRelFile(audit.rootDir, payload);
    }
  });
}

export async function showBaselineComparisonPicker(audit: FolderAudit): Promise<void> {
  const buildModel = async (): Promise<{
    model: InspectorViewModel;
    diff: Awaited<ReturnType<typeof compareAgainstBaseline>>;
  }> => {
    const diff = await compareAgainstBaseline(audit.rootDir);
    if (!diff.hasBaseline) {
      return {
        diff,
        model: {
          viewId: `baseline-${audit.rootDir}`,
          tabTitle: `Baseline: ${audit.name}`,
          heading: `Architecture Baseline: ${audit.name}`,
          subheading: `No ${BASELINE_FILENAME} found yet`,
          metrics: [],
          headerActions: [{ id: 'saveBaseline', label: 'Save Baseline Snapshot', primary: true }],
          emptyMessage: `Save a baseline snapshot before a refactor or upgrade, then compare afterward to verify zero regressions.`,
          sections: [],
        },
      };
    }

    const scoreStr = `${diff.baselineScore} -> ${diff.currentScore} (${diff.scoreDelta >= 0 ? '+' : ''}${diff.scoreDelta})`;
    const tokenStr = `${diff.tokenDelta >= 0 ? '+' : ''}${diff.tokenDelta.toLocaleString('en-US')} tok`;
    const statusTone =
      diff.status === 'regressed' ? 'error' : diff.status === 'improved' ? 'ok' : 'info';

    const sections: InspectorSection[] = [
      {
        title: `New Regressions Since Baseline (${diff.newFindings.length})`,
        rows: diff.newFindings.slice(0, 30).map((f) => ({
          title: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : f.id,
          badge: { text: f.id, tone: f.severity === 'error' ? 'error' : 'warn' },
          detail: f.message,
          actions: f.file ? [{ id: 'open', label: 'Open', payload: `${f.file}::${f.line ?? 0}` }] : [],
        })),
      },
      {
        title: 'External System Drift',
        rows: [
          ...diff.newExternalSystems.map((s) => ({
            title: s,
            badge: { text: 'Added', tone: 'info' as const },
          })),
          ...diff.removedExternalSystems.map((s) => ({
            title: s,
            badge: { text: 'Removed', tone: 'warn' as const },
          })),
        ],
      },
      {
        title: `Resolved Since Baseline (${diff.resolvedSignatures.length})`,
        rows: diff.resolvedSignatures.slice(0, 20).map((sig) => ({
          title: sig.split('::')[0],
          badge: { text: 'Resolved', tone: 'ok' as const },
          detail: sig.split('::').slice(1).filter(Boolean).join(' · '),
        })),
      },
    ];

    const headerActions = [{ id: 'saveBaseline', label: 'Update Baseline Snapshot', primary: diff.newFindings.length === 0 }];
    if (diff.newFindings.length > 0) {
      headerActions.unshift({ id: 'aiRegressions', label: 'Fix Regressions with AI Chat', primary: true });
    }

    return {
      diff,
      model: {
        viewId: `baseline-${audit.rootDir}`,
        tabTitle: `Baseline: ${audit.name}`,
        heading: `Architecture Baseline Diff: ${audit.name}`,
        subheading: `Saved ${diff.baselineCreatedAt ?? 'previously'}`,
        metrics: [
          { label: 'Status', value: diff.status.toUpperCase(), tone: statusTone },
          { label: 'Score', value: scoreStr, tone: diff.scoreDelta < 0 ? 'error' : 'ok' },
          { label: 'Regressions', value: String(diff.newFindings.length), tone: diff.newFindings.length > 0 ? 'error' : 'ok' },
          { label: 'Resolved', value: String(diff.resolvedSignatures.length), tone: 'ok' },
          { label: 'Token Delta', value: tokenStr },
        ],
        headerActions,
        emptyMessage: 'No drift detected since the saved architecture baseline.',
        sections,
      },
    };
  };

  let state = await buildModel();
  openInspectorPanel(state.model, async (actionId, payload) => {
    if (actionId === 'saveBaseline') {
      const { baseline } = await saveArchitectureBaseline(audit.rootDir);
      void vscode.window.showInformationMessage(
        `Saved ${BASELINE_FILENAME} (Score ${baseline.overallScore}/100, ${baseline.findingSignatures.length} findings).`
      );
      state = await buildModel();
      return state.model;
    }
    if (actionId === 'aiRegressions') {
      const prompt = [
        `Please fix these ${state.diff.newFindings.length} architecture/security regressions introduced in **${audit.name}** since the saved baseline:`,
        '',
        ...state.diff.newFindings
          .slice(0, 20)
          .map(
            (f) =>
              `- **[${f.id}]** ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.message}${f.suggestion ? ` Fix: ${f.suggestion}` : ''}`
          ),
      ].join('\n');
      await sendToAiChat(prompt, 'baseline regression');
    } else if (actionId === 'open' && payload) {
      const [rel, lineStr] = payload.split('::');
      await openRelFile(audit.rootDir, rel, lineStr ? Number(lineStr) : undefined);
    }
  });
}

export async function showTokenBreakdownPicker(
  audit: FolderAudit,
  onMutate?: () => Promise<void>
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('archpilot');
  const rate = cfg.get<number>('costPerMillionInputTokens', 3);

  const buildModel = async (): Promise<InspectorViewModel> => {
    const res = await analyzeTokenBreakdown(audit.rootDir, rate);
    return {
      viewId: `tokens-${audit.rootDir}`,
      tabTitle: `Token Breakdown: ${audit.name}`,
      heading: `AI Token Cost Breakdown: ${audit.name}`,
      subheading: `Estimated at $${rate}/1M input tokens (excludes .gitignore & .aiignore)`,
      metrics: [
        { label: 'Total Tokens', value: `~${res.totalTokens.toLocaleString('en-US')}`, tone: 'info' },
        { label: 'Full Read Cost', value: `~$${res.fullReadCostUsd.toFixed(3)}`, tone: res.fullReadCostUsd > 0.25 ? 'warn' : 'ok' },
        { label: 'Text Files', value: String(res.totalFiles) },
      ],
      sections: [
        {
          title: 'Top Folders by Token Usage',
          subtitle: 'Exclude heavy generated/fixture folders to cut AI context waste',
          rows: res.topFolders.map((f) => ({
            title: f.folder,
            meta: `~${f.estimatedTokens.toLocaleString('en-US')} tok (${f.percentOfRepo}%) · ~$${f.costPerReadUsd.toFixed(4)}/read · ${f.fileCount} files`,
            percent: f.percentOfRepo,
            actions:
              f.folder !== '(root)'
                ? [{ id: 'ignoreFolder', label: 'Exclude Folder', payload: f.folder }]
                : [],
          })),
        },
        {
          title: 'Top Heaviest Files',
          rows: res.topFiles.map((f) => ({
            title: f.file,
            meta: `~${f.estimatedTokens.toLocaleString('en-US')} tok · ~$${f.costPerReadUsd.toFixed(4)}/read`,
            actions: [
              { id: 'open', label: 'Open', payload: f.file },
              { id: 'ignoreFile', label: 'Exclude', payload: f.file },
            ],
          })),
        },
      ],
    };
  };

  openInspectorPanel(await buildModel(), async (actionId, payload) => {
    if (actionId === 'ignoreFolder' && payload) {
      const entry = `${payload}/`;
      await appendToIgnoreFile(path.join(audit.rootDir, '.aiignore'), [entry]);
      await appendToIgnoreFile(path.join(audit.rootDir, '.cursorignore'), [entry]);
      void vscode.window.showInformationMessage(`Excluded "${entry}" in .aiignore & .cursorignore.`);
      if (onMutate) await onMutate();
      return buildModel();
    }
    if (actionId === 'ignoreFile' && payload) {
      await appendToIgnoreFile(path.join(audit.rootDir, '.aiignore'), [payload]);
      await appendToIgnoreFile(path.join(audit.rootDir, '.cursorignore'), [payload]);
      void vscode.window.showInformationMessage(`Excluded "${payload}" in .aiignore & .cursorignore.`);
      if (onMutate) await onMutate();
      return buildModel();
    }
    if (actionId === 'open' && payload) {
      await openRelFile(audit.rootDir, payload);
    }
  });
}

export async function showUnusedDepsPicker(audit: FolderAudit): Promise<void> {
  const res = await findUnusedDependencies(audit.rootDir);
  const rootUnused = res.unused.filter((u) => u.packageJsonPath === 'package.json').map((u) => u.name);

  const headerActions = [];
  if (rootUnused.length > 0) {
    headerActions.push({
      id: 'uninstallRoot',
      label: `Run npm uninstall (${rootUnused.length})`,
      primary: true,
    });
  }
  if (res.unused.length > 0) {
    headerActions.push({ id: 'aiChat', label: 'Review with AI Chat', primary: rootUnused.length === 0 });
  }

  openInspectorPanel(
    {
      viewId: `unused-deps-${audit.rootDir}`,
      tabTitle: `Unused Deps: ${audit.name}`,
      heading: `Unused Runtime Dependencies: ${audit.name}`,
      subheading: 'Cross-checked against source imports, npm scripts, and build/CSS configs',
      metrics: [
        { label: 'Unused', value: String(res.unused.length), tone: res.unused.length > 0 ? 'warn' : 'ok' },
        { label: 'Total Runtime Deps', value: String(res.totalDependencies) },
      ],
      headerActions,
      emptyMessage:
        res.totalDependencies === 0
          ? `No package.json runtime dependencies found in ${audit.name}.`
          : `All ${res.totalDependencies} runtime dependencies in ${audit.name} are referenced.`,
      sections: [
        {
          title: `Unreferenced Packages (${res.unused.length})`,
          rows: res.unused.map((u) => ({
            title: u.name,
            badge: { text: u.version, tone: 'warn' },
            meta: u.packageJsonPath,
            actions: [{ id: 'openPkg', label: 'Open package.json', payload: u.packageJsonPath }],
          })),
        },
      ],
    },
    async (actionId, payload) => {
      if (actionId === 'uninstallRoot' && rootUnused.length > 0) {
        const term = vscode.window.createTerminal({
          name: `ArchPilot: npm uninstall (${audit.name})`,
          cwd: audit.rootDir,
        });
        term.show();
        term.sendText(`npm uninstall ${rootUnused.join(' ')}`);
      } else if (actionId === 'aiChat') {
        const prompt = [
          `ArchPilot detected ${res.unused.length} runtime dependencies in **${audit.name}** that are not directly imported in source files.`,
          'Please verify whether any are needed implicitly and safely remove the truly unused ones:',
          '',
          ...res.unused.map((u) => `- \`${u.name}\` (${u.version}) in \`${u.packageJsonPath}\``),
        ].join('\n');
        await sendToAiChat(prompt, 'unused dependencies');
      } else if (actionId === 'openPkg' && payload) {
        await openRelFile(audit.rootDir, payload);
      }
    }
  );
}

export async function showOpenApiDiffPicker(audit: FolderAudit): Promise<void> {
  const res = await analyzeOpenApiBreakingChanges(audit.rootDir);
  const mdSummary = [
    `### OpenAPI Breaking Changes (${audit.name} vs \`${res.comparedAgainst}\`)`,
    '',
    ...res.breakingChanges.map(
      (bc) => `- **[${bc.severity.toUpperCase()} / ${bc.ruleId}]** \`${bc.file}\`: ${bc.message} (${bc.suggestion})`
    ),
  ].join('\n');

  openInspectorPanel(
    {
      viewId: `openapi-diff-${audit.rootDir}`,
      tabTitle: `OpenAPI Diff: ${audit.name}`,
      heading: `OpenAPI Breaking-Change Diff: ${audit.name}`,
      subheading: `Compared against git ${res.comparedAgainst}`,
      metrics: [
        { label: 'Specs Checked', value: String(res.specsChecked) },
        { label: 'Breaking Changes', value: String(res.breakingChanges.length), tone: res.breakingChanges.length > 0 ? 'error' : 'ok' },
        { label: 'Added Endpoints', value: `+${res.addedEndpoints.length}`, tone: 'ok' },
      ],
      headerActions:
        res.breakingChanges.length > 0
          ? [
              { id: 'aiChat', label: 'Review with AI Chat', primary: true },
              { id: 'copySummary', label: 'Copy Markdown Summary' },
            ]
          : [],
      emptyMessage:
        res.specsChecked === 0
          ? `No OpenAPI / Swagger specification files found in ${audit.name}.`
          : `0 breaking changes detected across ${res.specsChecked} spec${res.specsChecked === 1 ? '' : 's'}.`,
      sections: [
        {
          title: `Breaking Changes (${res.breakingChanges.length})`,
          rows: res.breakingChanges.map((bc) => ({
            title: bc.file,
            badge: { text: bc.ruleId, tone: bc.severity === 'error' ? 'error' : 'warn' },
            meta: bc.message,
            detail: bc.suggestion,
            actions: [{ id: 'open', label: 'Open Spec', payload: bc.file }],
          })),
        },
        {
          title: `Additive Endpoints (${res.addedEndpoints.length})`,
          rows: res.addedEndpoints.map((ep) => ({
            title: ep,
            badge: { text: 'Added', tone: 'ok' },
          })),
        },
      ],
    },
    async (actionId, payload) => {
      if (actionId === 'copySummary') {
        await vscode.env.clipboard.writeText(mdSummary);
        void vscode.window.showInformationMessage('Copied OpenAPI breaking-change summary to clipboard.');
      } else if (actionId === 'aiChat') {
        await sendToAiChat(
          `Please help resolve or safely version these OpenAPI breaking changes in **${audit.name}**:\n\n${mdSummary}`,
          'OpenAPI review'
        );
      } else if (actionId === 'open' && payload) {
        await openRelFile(audit.rootDir, payload);
      }
    }
  );
}
