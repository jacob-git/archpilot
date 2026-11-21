import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import {
  auditRepository,
  DEFAULT_CONFIG,
  generateAgentsMd,
  generateArchitectureMd,
  generateArchMap,
  generateFixPrompt,
  generateGitignore,
  generateReadmeBadge,
  generateSmartArchPilotConfig,
  type Finding,
} from '@archpilot/core';
import { ArchPilotTreeProvider } from './treeProvider.js';
import { ArchPilotCodeActionProvider } from './codeActions.js';
import { openArchitectureGraph } from './graphView.js';
import {
  exportExecutiveHtmlReport,
  generateAndCopyPrBrief,
  runDependencyAuditPicker,
  showBlastRadiusPicker,
} from './reports.js';
import {
  estimateModelRateUsd,
  getDetectedChatModels,
  type FolderAudit,
  type TreeNode,
} from './types.js';

function toVsCodeSeverity(sev: Finding['severity']): vscode.DiagnosticSeverity {
  if (sev === 'error') return vscode.DiagnosticSeverity.Error;
  if (sev === 'warning') return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

async function pickWorkspaceFolder(placeHolder: string): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0].uri.fsPath;
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath,
      fsPath: f.uri.fsPath,
    })),
    { placeHolder }
  );
  return picked?.fsPath;
}

function rootDirFromNode(node?: TreeNode): string | undefined {
  return node?.audit.rootDir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function openFileInEditor(filePath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}

async function addIgnoreToConfig(rootDir: string, relPath: string): Promise<void> {
  const configPath = path.join(rootDir, 'archpilot.json');
  let configObj: Record<string, unknown>;
  if (await exists(configPath)) {
    try {
      configObj = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      void vscode.window.showErrorMessage('archpilot.json contains invalid JSON.');
      return;
    }
  } else {
    configObj = {
      maxFileLines: DEFAULT_CONFIG.maxFileLines,
      ignore: ['node_modules', 'dist', 'build', 'coverage'],
      boundaries: [],
    };
  }

  const currentIgnore = Array.isArray(configObj.ignore)
    ? configObj.ignore.filter((x): x is string => typeof x === 'string')
    : [];
  if (!currentIgnore.includes(relPath)) {
    currentIgnore.push(relPath);
  }
  configObj.ignore = currentIgnore;
  await writeFile(configPath, JSON.stringify(configObj, null, 2) + '\n', 'utf8');
}

async function appendToIgnoreFile(filePath: string, entries: string[]): Promise<number> {
  const existing = (await exists(filePath)) ? await readFile(filePath, 'utf8') : '';
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

async function syncAiIgnoreFiles(rootDir: string, entries: string[]): Promise<number> {
  const added = await appendToIgnoreFile(path.join(rootDir, '.aiignore'), entries);
  await appendToIgnoreFile(path.join(rootDir, '.cursorignore'), entries);
  return added;
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('archpilot');
  const treeProvider = new ArchPilotTreeProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'archpilot.refresh';

  const fileTokenBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  fileTokenBar.command = 'archpilot.selectModelPreset';

  const updateActiveFileTokens = (editor?: vscode.TextEditor): void => {
    if (!editor || editor.document.uri.scheme !== 'file') {
      fileTokenBar.hide();
      return;
    }
    const text = editor.document.getText();
    const tokens = Math.ceil(text.length / 4);
    const isLarge = tokens >= DEFAULT_CONFIG.maxFileTokens;
    const cfg = vscode.workspace.getConfiguration('archpilot');
    const rate = cfg.get<number>('costPerMillionInputTokens', 3);
    const singleReadCost = (tokens * rate) / 1_000_000;

    fileTokenBar.text = isLarge
      ? `$(warning) ~${tokens.toLocaleString('en-US')} tok`
      : `$(file-code) ~${tokens.toLocaleString('en-US')} tok`;
    fileTokenBar.backgroundColor = isLarge
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    fileTokenBar.tooltip = [
      `Active file: ${path.basename(editor.document.fileName)}`,
      `Estimated size: ~${tokens.toLocaleString('en-US')} tokens (~$${singleReadCost.toFixed(4)} per read at $${rate}/1M)`,
      isLarge
        ? 'Large file warning: attaching this file to AI chat will consume significant context tokens.'
        : 'Click to change model pricing preset.',
    ].join('\n');
    fileTokenBar.show();
  };

  let auditInFlight = false;
  let auditQueued = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const runAudit = async (): Promise<void> => {
    if (auditInFlight) {
      auditQueued = true;
      return;
    }
    auditInFlight = true;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      treeProvider.setAudits([]);
      diagnostics.clear();
      statusBar.hide();
      auditInFlight = false;
      return;
    }

    try {
      const cfg = vscode.workspace.getConfiguration('archpilot');
      const inputPerMillionUsd = cfg.get<number>('costPerMillionInputTokens', 3);
      const modelLabel = cfg.get<string>('modelPresetLabel', `Standard ($${inputPerMillionUsd}/1M)`);

      const audits: FolderAudit[] = await Promise.all(
        folders.map(async (folder) => ({
          name: folder.name,
          rootDir: folder.uri.fsPath,
          report: await auditRepository(folder.uri.fsPath, {
            inputPerMillionUsd,
            modelLabel,
          }),
        }))
      );

      treeProvider.setAudits(audits);

      if (audits.length === 1) {
        const r = audits[0].report;
        statusBar.text = `$(shield) ArchPilot: ${r.overallScore}/100`;
        statusBar.tooltip = `${audits[0].name}: Grade ${r.grade} (${r.summary.errors} errors, ${r.summary.warnings} warnings) — Click to refresh`;
      } else {
        const minScore = Math.min(...audits.map((a) => a.report.overallScore));
        statusBar.text = `$(shield) ArchPilot: ${minScore}/100 (${audits.length} repos)`;
        statusBar.tooltip = audits
          .map(
            (a) =>
              `${a.name}: ${a.report.overallScore}/100 (Grade ${a.report.grade}, ${a.report.summary.errors}E / ${a.report.summary.warnings}W)`
          )
          .join('\n');
      }
      statusBar.show();

      diagnostics.clear();
      const byFile = new Map<string, vscode.Diagnostic[]>();
      for (const { rootDir, report } of audits) {
        for (const finding of report.findings) {
          if (!finding.file) continue;
          const abs = path.join(rootDir, finding.file);
          const lineIdx = Math.max(0, (finding.line ?? 1) - 1);
          const diag = new vscode.Diagnostic(
            new vscode.Range(lineIdx, 0, lineIdx, 200),
            finding.suggestion ? `${finding.message} (${finding.suggestion})` : finding.message,
            toVsCodeSeverity(finding.severity)
          );
          diag.source = 'ArchPilot';
          diag.code = finding.id;
          const list = byFile.get(abs) ?? [];
          list.push(diag);
          byFile.set(abs, list);
        }
      }
      for (const [abs, list] of byFile.entries()) {
        diagnostics.set(vscode.Uri.file(abs), list);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`ArchPilot audit failed: ${msg}`);
    } finally {
      auditInFlight = false;
      if (auditQueued) {
        auditQueued = false;
        void runAudit();
      }
    }
  };

  const scheduleAudit = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runAudit();
    }, 400);
  };

  const resolveAuditForNode = async (
    node?: TreeNode,
    placeHolder = 'Select project folder'
  ): Promise<FolderAudit | undefined> => {
    if (node) return node.audit;
    const audits = treeProvider.getAudits();
    if (audits.length === 1) return audits[0];
    const dir = await pickWorkspaceFolder(placeHolder);
    return audits.find((a) => a.rootDir === dir);
  };

  context.subscriptions.push(
    diagnostics,
    statusBar,
    fileTokenBar,
    vscode.window.registerTreeDataProvider('archpilot.auditView', treeProvider),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new ArchPilotCodeActionProvider(treeProvider),
      { providedCodeActionKinds: ArchPilotCodeActionProvider.providedCodeActionKinds }
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => updateActiveFileTokens(editor)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor?.document === e.document) {
        updateActiveFileTokens(vscode.window.activeTextEditor);
      }
    }),
    vscode.commands.registerCommand('archpilot.refresh', runAudit),

    vscode.commands.registerCommand('archpilot.openGraph', async (node?: TreeNode) => {
      const audit = await resolveAuditForNode(
        node,
        'Select project folder to open Architecture Graph'
      );
      if (!audit) return;
      const scoreLabel = `${audit.report.overallScore}/100 (Grade ${audit.report.grade})`;
      await openArchitectureGraph(audit.rootDir, scoreLabel);
    }),

    vscode.commands.registerCommand('archpilot.checkBlastRadius', async (node?: TreeNode) => {
      const audit = await resolveAuditForNode(
        node,
        'Select project folder to check Git Diff & Blast Radius'
      );
      if (!audit) return;
      await showBlastRadiusPicker(audit);
    }),

    vscode.commands.registerCommand('archpilot.exportHtmlReport', async (node?: TreeNode) => {
      const audit = await resolveAuditForNode(
        node,
        'Select project folder to export Executive HTML Report'
      );
      if (!audit) return;
      await exportExecutiveHtmlReport(audit);
    }),

    vscode.commands.registerCommand('archpilot.generatePrBrief', async (node?: TreeNode) => {
      const audit = await resolveAuditForNode(
        node,
        'Select project folder to generate PR & QA Handoff Brief'
      );
      if (!audit) return;
      await generateAndCopyPrBrief(audit);
    }),

    vscode.commands.registerCommand('archpilot.auditDependencies', async (node?: TreeNode) => {
      const audit = await resolveAuditForNode(
        node,
        'Select project folder to audit dependency CVEs'
      );
      if (!audit) return;
      await runDependencyAuditPicker(audit);
    }),

    vscode.commands.registerCommand('archpilot.generateAgentsMd', async (node?: TreeNode) => {
      const rootDir =
        rootDirFromNode(node) ?? (await pickWorkspaceFolder('Select project folder for AGENTS.md'));
      if (!rootDir) return;
      const target = path.join(rootDir, 'AGENTS.md');
      if (await exists(target)) {
        void vscode.window.showInformationMessage('AGENTS.md already exists in this folder.');
        return;
      }
      await writeFile(target, await generateAgentsMd(rootDir), 'utf8');
      await openFileInEditor(target);
      await runAudit();
    }),

    vscode.commands.registerCommand('archpilot.initConfig', async (node?: TreeNode) => {
      const rootDir =
        rootDirFromNode(node) ??
        (await pickWorkspaceFolder('Select project folder for archpilot.json'));
      if (!rootDir) return;
      const target = path.join(rootDir, 'archpilot.json');
      if (await exists(target)) {
        void vscode.window.showInformationMessage('archpilot.json already exists in this folder.');
        return;
      }
      await writeFile(target, await generateSmartArchPilotConfig(rootDir), 'utf8');
      await openFileInEditor(target);
      await runAudit();
    }),

    vscode.commands.registerCommand('archpilot.generateArchMap', async (node?: TreeNode) => {
      const rootDir =
        rootDirFromNode(node) ??
        (await pickWorkspaceFolder('Select project folder for ARCHMAP.md'));
      if (!rootDir) return;
      const content = await generateArchMap(rootDir);
      const target = path.join(rootDir, 'ARCHMAP.md');
      await writeFile(target, content, 'utf8');
      await openFileInEditor(target);
      void vscode.window.showInformationMessage(
        `Generated ARCHMAP.md (~${Math.ceil(content.length / 4)} tokens) so AI agents can locate modules in 1 read.`
      );
    }),

    vscode.commands.registerCommand('archpilot.generateArchitectureMd', async (node?: TreeNode) => {
      const rootDir =
        rootDirFromNode(node) ??
        (await pickWorkspaceFolder('Select project folder for ARCHITECTURE.md'));
      if (!rootDir) return;
      const md = await generateArchitectureMd(rootDir);
      const target = path.join(rootDir, 'ARCHITECTURE.md');
      await writeFile(target, md, 'utf8');
      await openFileInEditor(target);
      void vscode.window.showInformationMessage(
        'Generated ARCHITECTURE.md with live Mermaid system & external integrations diagram.'
      );
    }),

    vscode.commands.registerCommand('archpilot.autoFixProject', async (node?: TreeNode) => {
      const audit = await resolveAuditForNode(node, 'Select project folder to auto-fix');
      if (!audit) return;

      const created: string[] = [];
      const findingIds = new Set(audit.report.findings.map((f) => f.id));

      if (findingIds.has('missing-agent-instructions')) {
        const target = path.join(audit.rootDir, 'AGENTS.md');
        if (!(await exists(target))) {
          await writeFile(target, await generateAgentsMd(audit.rootDir), 'utf8');
          created.push('AGENTS.md');
        }
      }

      if (findingIds.has('no-boundary-rules')) {
        const target = path.join(audit.rootDir, 'archpilot.json');
        if (!(await exists(target))) {
          await writeFile(target, await generateSmartArchPilotConfig(audit.rootDir), 'utf8');
          created.push('archpilot.json');
        }
      }

      if (findingIds.has('missing-gitignore')) {
        const target = path.join(audit.rootDir, '.gitignore');
        if (!(await exists(target))) {
          await writeFile(target, generateGitignore(), 'utf8');
          created.push('.gitignore');
        }
      }

      await runAudit();

      if (created.length > 0) {
        void vscode.window.showInformationMessage(
          `ArchPilot created ${created.join(', ')} in ${audit.name}.`
        );
      } else {
        const action = await vscode.window.showInformationMessage(
          `No automatic file fixes left in ${audit.name}. Copy an AI Fix Prompt for the remaining findings?`,
          'Copy Fix Prompt'
        );
        if (action === 'Copy Fix Prompt') {
          await vscode.env.clipboard.writeText(generateFixPrompt(audit.report));
          void vscode.window.showInformationMessage('Copied AI Fix Prompt to clipboard.');
        }
      }
    }),

    vscode.commands.registerCommand('archpilot.quickFixFinding', async (node?: TreeNode) => {
      if (!node || node.kind !== 'finding') return;
      const { finding, audit } = node;

      if (finding.id === 'missing-agent-instructions') {
        const target = path.join(audit.rootDir, 'AGENTS.md');
        await writeFile(target, await generateAgentsMd(audit.rootDir), 'utf8');
        await openFileInEditor(target);
        await runAudit();
        return;
      }

      if (finding.id === 'no-boundary-rules') {
        const target = path.join(audit.rootDir, 'archpilot.json');
        await writeFile(target, await generateSmartArchPilotConfig(audit.rootDir), 'utf8');
        await openFileInEditor(target);
        await runAudit();
        return;
      }

      if (finding.id === 'missing-gitignore') {
        const target = path.join(audit.rootDir, '.gitignore');
        await writeFile(target, generateGitignore(), 'utf8');
        await openFileInEditor(target);
        await runAudit();
        return;
      }

      if (finding.id === 'exposed-secret-file' && finding.file) {
        await appendToIgnoreFile(path.join(audit.rootDir, '.gitignore'), [finding.file]);
        await runAudit();
        void vscode.window.showWarningMessage(
          `Added "${finding.file}" to .gitignore. Remember to run \`git rm --cached ${finding.file}\` if tracked and rotate exposed credentials.`
        );
        return;
      }

      if (finding.id === 'poisoned-agent-instructions' && finding.file) {
        const target = path.join(audit.rootDir, finding.file);
        const raw = await readFile(target, 'utf8');
        const cleaned = raw.replace(/[\u200B-\u200D\u202A-\u202E\u2066-\u2069]/g, '');
        await writeFile(target, cleaned, 'utf8');
        await openFileInEditor(target);
        await runAudit();
        void vscode.window.showInformationMessage(
          `Stripped hidden invisible Unicode characters from ${finding.file}.`
        );
        return;
      }

      if (finding.id === 'insecure-tls' && finding.file) {
        const target = path.join(audit.rootDir, finding.file);
        const raw = await readFile(target, 'utf8');
        const lines = raw.split(/\r?\n/);
        const idx = Math.max(0, (finding.line ?? 1) - 1);
        if (lines[idx]) {
          lines[idx] = lines[idx]
            .replace(/rejectUnauthorized\s*:\s*false/g, 'rejectUnauthorized: true')
            .replace(/\bverify\s*=\s*False\b/g, 'verify=True');
          await writeFile(target, lines.join('\n'), 'utf8');
          await openFileInEditor(target);
          await runAudit();
          void vscode.window.showInformationMessage(
            `Re-enabled TLS certificate verification in ${finding.file}:${finding.line ?? 1}.`
          );
          return;
        }
      }

      await vscode.env.clipboard.writeText(generateFixPrompt(audit.report, finding));
      void vscode.window.showInformationMessage('Copied targeted AI Fix Prompt to clipboard.');
    }),

    vscode.commands.registerCommand('archpilot.fixWithAiChat', async (node?: TreeNode) => {
      let prompt: string;
      let label: string;
      if (node && node.kind === 'finding') {
        prompt = generateFixPrompt(node.audit.report, node.finding);
        label = `[${node.finding.id}]`;
      } else if (node && node.kind === 'category') {
        const scopedReport = { ...node.audit.report, findings: node.category.findings };
        prompt = generateFixPrompt(scopedReport);
        label = node.category.label;
      } else {
        const audit = await resolveAuditForNode(node, 'Select project folder to fix with AI Chat');
        if (!audit) return;
        prompt = generateFixPrompt(audit.report);
        label = audit.name;
      }

      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
      } catch {
        await vscode.env.clipboard.writeText(prompt);
        void vscode.window.showInformationMessage(
          `Copied AI Fix Prompt for ${label} to clipboard — paste it into your AI chat.`
        );
      }
    }),

    vscode.commands.registerCommand('archpilot.ignoreFindingFile', async (node?: TreeNode) => {
      if (!node || node.kind !== 'finding' || !node.finding.file) return;
      await addIgnoreToConfig(node.audit.rootDir, node.finding.file);
      await runAudit();
      void vscode.window.showInformationMessage(
        `Added "${node.finding.file}" to archpilot.json ignore list.`
      );
    }),

    vscode.commands.registerCommand('archpilot.addToAiIgnore', async (node?: TreeNode) => {
      if (!node || node.kind !== 'finding' || !node.finding.file) return;
      await syncAiIgnoreFiles(node.audit.rootDir, [node.finding.file]);
      await runAudit();
      void vscode.window.showInformationMessage(
        `Added "${node.finding.file}" to .aiignore & .cursorignore to save AI agent tokens.`
      );
    }),

    vscode.commands.registerCommand('archpilot.selectModelPreset', async () => {
      interface PricingPickItem extends vscode.QuickPickItem {
        rate: number;
        short: string;
      }

      const items: PricingPickItem[] = [];
      const liveModels = await getDetectedChatModels();
      const seen = new Set<string>();

      if (liveModels.length > 0) {
        items.push({
          label: 'Detected in VS Code / Copilot',
          kind: vscode.QuickPickItemKind.Separator,
          rate: 0,
          short: '',
        });
        for (const m of liveModels) {
          const displayName = m.name || m.family || m.id;
          const key = displayName.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const rate = estimateModelRateUsd(`${m.id} ${m.name ?? ''} ${m.family ?? ''}`);
          items.push({
            label: displayName,
            description: `~$${rate}/1M input${m.vendor ? ` · ${m.vendor}` : ''}`,
            rate,
            short: `${displayName} ($${rate}/1M)`,
          });
        }
      }

      items.push(
        {
          label: 'General Pricing Tiers',
          kind: vscode.QuickPickItemKind.Separator,
          rate: 0,
          short: '',
        },
        {
          label: 'Fast / Flash / Mini',
          description: '$0.30/1M input (Gemini Flash, GPT-4o-mini, o4-mini)',
          rate: 0.3,
          short: 'Fast ($0.30/1M)',
        },
        {
          label: 'Standard / Sonnet / GPT-4o',
          description: '$3/1M input (Claude Sonnet, GPT-4o, GPT-4.1)',
          rate: 3,
          short: 'Standard ($3/1M)',
        },
        {
          label: 'High-Reasoning / GPT-5+ / o3',
          description: '$5/1M input (GPT-5, GPT-6, o3)',
          rate: 5,
          short: 'Reasoning ($5/1M)',
        },
        {
          label: 'Frontier / Opus',
          description: '$15/1M input (Claude Opus)',
          rate: 15,
          short: 'Frontier ($15/1M)',
        },
        {
          label: 'Custom rate...',
          description: 'Enter any exact $ per 1M input token price',
          rate: -1,
          short: 'Custom',
        }
      );

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a detected Copilot/VS Code model or pricing tier',
      });
      if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) return;

      let rate = picked.rate;
      let shortLabel = picked.short;
      if (rate < 0) {
        const raw = await vscode.window.showInputBox({
          prompt: 'Enter input token cost in USD per 1M tokens (e.g., 2.5)',
          value: '3',
          validateInput: (v) => (Number(v) > 0 ? undefined : 'Enter a positive number'),
        });
        if (!raw) return;
        rate = Number(raw);
        shortLabel = `Custom ($${rate}/1M)`;
      }

      const cfg = vscode.workspace.getConfiguration('archpilot');
      await cfg.update('costPerMillionInputTokens', rate, vscode.ConfigurationTarget.Global);
      await cfg.update('modelPresetLabel', shortLabel, vscode.ConfigurationTarget.Global);
      updateActiveFileTokens(vscode.window.activeTextEditor);
      await runAudit();
    }),

    vscode.commands.registerCommand('archpilot.optimizeTokenCost', async (node?: TreeNode) => {
      const audit = await resolveAuditForNode(node, 'Select project folder to optimize token cost');
      if (!audit) return;

      const tf = audit.report.tokenFootprint;
      const savedEstimate = tf.costEstimate.potentialMonthlySavingsUsd;
      let addedCount = 0;

      if (tf.tokenSinks.length > 0) {
        addedCount = await syncAiIgnoreFiles(
          audit.rootDir,
          tf.tokenSinks.map((s) => s.file)
        );
      }

      await runAudit();

      const hasBloatedInstructions = audit.report.findings.some(
        (f) => f.id === 'instruction-token-budget'
      );

      if (addedCount > 0 && !hasBloatedInstructions) {
        void vscode.window.showInformationMessage(
          `Added ${addedCount} large file${addedCount > 1 ? 's' : ''} to .aiignore & .cursorignore — estimated savings ~$${savedEstimate.toFixed(2)}/mo/dev!`
        );
      } else if (hasBloatedInstructions) {
        const msg =
          addedCount > 0
            ? `Added ${addedCount} large files to .aiignore & .cursorignore. Your always-on instructions are still ~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} tokens/turn — copy a prompt to compress them?`
            : `Your always-on instructions are ~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} tokens/turn (~$${tf.costEstimate.alwaysOnMonthlyUsd.toFixed(2)}/mo/dev). Copy a prompt to compress them by 50%?`;
        const choice = await vscode.window.showInformationMessage(msg, 'Copy Compression Prompt');
        if (choice === 'Copy Compression Prompt') {
          await vscode.env.clipboard.writeText(
            `Please compress the always-on AI instruction files (AGENTS.md / CLAUDE.md / .cursor/rules) in **${audit.name}** by ~50% (target under 2,500 total tokens) while keeping every critical command, architecture boundary, and convention intact. Move verbose examples into on-demand docs.`
          );
          void vscode.window.showInformationMessage('Copied instruction compression prompt to clipboard.');
        }
      } else {
        void vscode.window.showInformationMessage(
          `${audit.name} already has 0 unignored large files and lean instruction tokens.`
        );
      }
    }),

    vscode.commands.registerCommand('archpilot.copyFixPrompt', async (node?: TreeNode) => {
      if (node && node.kind === 'finding') {
        await vscode.env.clipboard.writeText(generateFixPrompt(node.audit.report, node.finding));
        void vscode.window.showInformationMessage(
          `Copied AI Fix Prompt for [${node.finding.id}] to clipboard.`
        );
        return;
      }
      if (node && node.kind === 'category') {
        const scopedReport = { ...node.audit.report, findings: node.category.findings };
        await vscode.env.clipboard.writeText(generateFixPrompt(scopedReport));
        void vscode.window.showInformationMessage(
          `Copied AI Fix Prompt for ${node.category.label} (${node.category.findings.length} finding${node.category.findings.length > 1 ? 's' : ''}) to clipboard.`
        );
        return;
      }
      const audit = await resolveAuditForNode(node, 'Select project folder to copy fix prompt');
      if (!audit) return;
      await vscode.env.clipboard.writeText(generateFixPrompt(audit.report));
      void vscode.window.showInformationMessage(
        `Copied AI Fix Prompt for ${audit.name} to clipboard — paste into Copilot, Cursor, or Claude.`
      );
    }),

    vscode.commands.registerCommand('archpilot.copyBadge', async (node?: TreeNode) => {
      const audit = await resolveAuditForNode(node, 'Select project folder to copy badge');
      if (!audit) return;
      await vscode.env.clipboard.writeText(generateReadmeBadge(audit.report));
      void vscode.window.showInformationMessage(
        `Copied README badge (${audit.report.overallScore}/100) to clipboard.`
      );
    }),

    vscode.workspace.onDidSaveTextDocument(() => {
      scheduleAudit();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scheduleAudit();
    }),
    {
      dispose: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
      },
    }
  );

  updateActiveFileTokens(vscode.window.activeTextEditor);
  void runAudit();
}

export function deactivate(): void {
  // nothing to clean up
}
