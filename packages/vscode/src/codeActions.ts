import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ArchPilotTreeProvider } from './treeProvider.js';
import { DETERMINISTIC_FIXABLE_RULES, type TreeNode } from './types.js';

export class ArchPilotCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly treeProvider: ArchPilotTreeProvider) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const archDiags = context.diagnostics.filter((d) => d.source === 'ArchPilot');
    if (archDiags.length === 0) return actions;

    const docPath = document.uri.fsPath;
    const audits = this.treeProvider.getAudits();
    const audit = audits.find((a) => docPath.startsWith(a.rootDir + path.sep) || docPath === a.rootDir);
    if (!audit) return actions;

    const relPath = path.relative(audit.rootDir, docPath).split(path.sep).join('/');

    for (const diag of archDiags) {
      const ruleId = typeof diag.code === 'string' ? diag.code : String(diag.code ?? '');
      const lineNum = diag.range.start.line + 1;
      const finding =
        audit.report.findings.find(
          (f) => f.id === ruleId && f.file === relPath && (f.line ?? 1) === lineNum
        ) ?? audit.report.findings.find((f) => f.id === ruleId && f.file === relPath);

      if (!finding) continue;
      const node: TreeNode = { kind: 'finding', finding, audit };

      if (DETERMINISTIC_FIXABLE_RULES.has(finding.id)) {
        const quickFix = new vscode.CodeAction(
          `ArchPilot: Quick Fix (${finding.id})`,
          vscode.CodeActionKind.QuickFix
        );
        quickFix.diagnostics = [diag];
        quickFix.isPreferred = true;
        quickFix.command = {
          command: 'archpilot.quickFixFinding',
          title: 'ArchPilot Quick Fix',
          arguments: [node],
        };
        actions.push(quickFix);
      }

      const aiFix = new vscode.CodeAction(
        `ArchPilot: Fix with AI Chat (${finding.id})`,
        vscode.CodeActionKind.QuickFix
      );
      aiFix.diagnostics = [diag];
      aiFix.command = {
        command: 'archpilot.fixWithAiChat',
        title: 'ArchPilot Fix with AI Chat',
        arguments: [node],
      };
      actions.push(aiFix);

      if (finding.id === 'token-sink' || finding.id === 'oversized-file') {
        const ignoreAi = new vscode.CodeAction(
          'ArchPilot: Add file to .aiignore & .cursorignore',
          vscode.CodeActionKind.QuickFix
        );
        ignoreAi.diagnostics = [diag];
        ignoreAi.command = {
          command: 'archpilot.addToAiIgnore',
          title: 'Add to .aiignore',
          arguments: [node],
        };
        actions.push(ignoreAi);
      }
    }

    return actions;
  }
}
