import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import {
  auditRepository,
  DEFAULT_CONFIG,
  generateAgentsMd,
  generateArchPilotConfig,
  generateFixPrompt,
  generateGitignore,
  generateReadmeBadge,
  type AuditReport,
  type CategoryScore,
  type Finding,
} from '@archpilot/core';

interface FolderAudit {
  name: string;
  rootDir: string;
  report: AuditReport;
}

type TreeNode =
  | { kind: 'folder'; audit: FolderAudit }
  | { kind: 'summary'; audit: FolderAudit }
  | { kind: 'category'; category: CategoryScore; audit: FolderAudit }
  | { kind: 'finding'; finding: Finding; audit: FolderAudit };

const DETERMINISTIC_FIXABLE_RULES = new Set([
  'missing-agent-instructions',
  'no-boundary-rules',
  'missing-gitignore',
]);

function findingContextValue(finding: Finding): string {
  const fixable = DETERMINISTIC_FIXABLE_RULES.has(finding.id) ? '.fixable' : '';
  const hasFile = finding.file ? '.file' : '';
  return `archpilot.finding${fixable}${hasFile}`;
}

function formatStackTags(report: AuditReport): string {
  const tags = [
    ...report.detectedStack.languages,
    ...report.detectedStack.frameworks,
    ...report.detectedStack.capabilities,
  ];
  return tags.length > 0 ? tags.join(' · ') : 'generic';
}

function formatTokenLine(report: AuditReport): string {
  const tf = report.tokenFootprint;
  const sinks =
    tf.tokenSinks.length > 0
      ? `${tf.tokenSinks.length} token sinks (~${tf.totalSinkTokens.toLocaleString('en-US')} tokens)`
      : '0 unignored token sinks';
  return `~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} always-on tokens/turn · ${sinks}`;
}

class ArchPilotTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private audits: FolderAudit[] = [];

  setAudits(audits: FolderAudit[]): void {
    this.audits = audits;
    this._onDidChangeTreeData.fire(undefined);
  }

  getAudits(): FolderAudit[] {
    return this.audits;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'folder') {
      const { name, report } = node.audit;
      const item = new vscode.TreeItem(
        `${name} — ${report.overallScore}/100 (Grade ${report.grade})`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `${report.summary.errors}E · ${report.summary.warnings}W · ${report.summary.infos}I`;
      item.tooltip = `${node.audit.rootDir}\nStack: ${formatStackTags(report)}\nTokens: ${formatTokenLine(report)}\n${report.summary.filesScanned} files scanned in ${report.summary.durationMs}ms\nRight-click for actions`;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue =
        report.findings.length > 0 ? 'archpilot.project.hasIssues' : 'archpilot.project.clean';
      return item;
    }

    if (node.kind === 'summary') {
      const { report } = node.audit;
      const item = new vscode.TreeItem(
        `Overall Score: ${report.overallScore}/100 (Grade ${report.grade})`,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = `${report.summary.errors}E · ${report.summary.warnings}W · ${report.summary.infos}I`;
      item.tooltip =
        report.findings.length > 0
          ? `${node.audit.rootDir}\nStack: ${formatStackTags(report)}\nTokens: ${formatTokenLine(report)}\nRight-click to Auto-Fix, Copy AI Fix Prompt, or Copy Badge`
          : `${node.audit.rootDir}\nStack: ${formatStackTags(report)}\nTokens: ${formatTokenLine(report)}\nAll checks passed! Right-click to Copy README Badge`;
      item.iconPath = new vscode.ThemeIcon('shield');
      item.contextValue =
        report.findings.length > 0 ? 'archpilot.project.hasIssues' : 'archpilot.project.clean';
      return item;
    }

    if (node.kind === 'category') {
      const hasFindings = node.category.findings.length > 0;
      const item = new vscode.TreeItem(
        `${node.category.label} (${node.category.score}/100)`,
        hasFindings
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon(
        hasFindings ? 'warning' : 'pass',
        hasFindings
          ? new vscode.ThemeColor('problemsWarningIcon.foreground')
          : new vscode.ThemeColor('testing.iconPassed')
      );
      return item;
    }

    const { finding, audit } = node;
    const item = new vscode.TreeItem(finding.message, vscode.TreeItemCollapsibleState.None);
    item.contextValue = findingContextValue(finding);
    const locationText = finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
      : undefined;
    item.tooltip = [
      locationText,
      finding.message,
      finding.suggestion ? `Fix: ${finding.suggestion}` : undefined,
      'Right-click for Quick Fix, Ignore, or Copy AI Fix Prompt',
    ]
      .filter(Boolean)
      .join('\n\n');
    item.description = finding.file
      ? `${path.basename(finding.file)}${finding.line ? `:${finding.line}` : ''}`
      : finding.id;

    if (finding.severity === 'error') {
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    } else if (finding.severity === 'warning') {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    } else {
      item.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('problemsInfoIcon.foreground'));
    }

    if (finding.file) {
      const targetUri = vscode.Uri.file(path.join(audit.rootDir, finding.file));
      const lineIdx = Math.max(0, (finding.line ?? 1) - 1);
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [
          targetUri,
          { selection: new vscode.Range(lineIdx, 0, lineIdx, 0) },
        ],
      };
    }

    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (this.audits.length === 0) {
      return [];
    }

    if (!element) {
      if (this.audits.length === 1) {
        const single = this.audits[0];
        return [
          { kind: 'summary', audit: single },
          ...single.report.categories.map(
            (category): TreeNode => ({
              kind: 'category',
              category,
              audit: single,
            })
          ),
        ];
      }
      return this.audits.map((audit): TreeNode => ({ kind: 'folder', audit }));
    }

    if (element.kind === 'folder') {
      return element.audit.report.categories.map(
        (category): TreeNode => ({
          kind: 'category',
          category,
          audit: element.audit,
        })
      );
    }

    if (element.kind === 'category') {
      return element.category.findings.map(
        (finding): TreeNode => ({
          kind: 'finding',
          finding,
          audit: element.audit,
        })
      );
    }

    return [];
  }
}

function toVsCodeSeverity(sev: Finding['severity']): vscode.DiagnosticSeverity {
  if (sev === 'error') return vscode.DiagnosticSeverity.Error;
  if (sev === 'warning') return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

async function pickWorkspaceFolder(placeHolder: string): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
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
  if (!node) return undefined;
  return node.audit.rootDir;
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

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('archpilot');
  const treeProvider = new ArchPilotTreeProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'archpilot.refresh';

  const runAudit = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      treeProvider.setAudits([]);
      diagnostics.clear();
      statusBar.hide();
      return;
    }

    try {
      const audits: FolderAudit[] = await Promise.all(
        folders.map(async (folder) => ({
          name: folder.name,
          rootDir: folder.uri.fsPath,
          report: await auditRepository(folder.uri.fsPath),
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
    }
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
    vscode.window.registerTreeDataProvider('archpilot.auditView', treeProvider),
    vscode.commands.registerCommand('archpilot.refresh', runAudit),

    vscode.commands.registerCommand('archpilot.generateAgentsMd', async (node?: TreeNode) => {
      const rootDir =
        rootDirFromNode(node) ?? (await pickWorkspaceFolder('Select project folder for AGENTS.md'));
      if (!rootDir) return;
      const target = path.join(rootDir, 'AGENTS.md');
      if (await exists(target)) {
        void vscode.window.showInformationMessage('AGENTS.md already exists in this folder.');
        return;
      }
      const content = await generateAgentsMd(rootDir);
      await writeFile(target, content, 'utf8');
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
      await writeFile(target, generateArchPilotConfig(), 'utf8');
      await openFileInEditor(target);
      await runAudit();
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
          await writeFile(target, generateArchPilotConfig(), 'utf8');
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
        await writeFile(target, generateArchPilotConfig(), 'utf8');
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

      await vscode.env.clipboard.writeText(generateFixPrompt(audit.report, finding));
      void vscode.window.showInformationMessage('Copied targeted AI Fix Prompt to clipboard.');
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
      const aiIgnorePath = path.join(node.audit.rootDir, '.aiignore');
      let existing = '';
      if (await exists(aiIgnorePath)) {
        existing = await readFile(aiIgnorePath, 'utf8');
      }
      const lines = existing
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.includes(node.finding.file)) {
        const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        await writeFile(aiIgnorePath, `${existing}${prefix}${node.finding.file}\n`, 'utf8');
      }
      await runAudit();
      void vscode.window.showInformationMessage(
        `Added "${node.finding.file}" to .aiignore to reduce AI agent token burn.`
      );
    }),

    vscode.commands.registerCommand('archpilot.copyFixPrompt', async (node?: TreeNode) => {
      if (node && node.kind === 'finding') {
        await vscode.env.clipboard.writeText(generateFixPrompt(node.audit.report, node.finding));
        void vscode.window.showInformationMessage(
          `Copied AI Fix Prompt for [${node.finding.id}] to clipboard.`
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
      void runAudit();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void runAudit();
    })
  );

  void runAudit();
}

export function deactivate(): void {
  // nothing to clean up
}
