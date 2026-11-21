import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  findingContextValue,
  formatStackTags,
  formatTokenLine,
  projectContextValue,
  type FolderAudit,
  type TreeNode,
} from './types.js';

export class ArchPilotTreeProvider implements vscode.TreeDataProvider<TreeNode> {
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
      item.contextValue = projectContextValue(report);
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
      item.contextValue = projectContextValue(report);
      return item;
    }

    if (node.kind === 'tokenCost') {
      const { report } = node.audit;
      const tf = report.tokenFootprint;
      const c = tf.costEstimate;
      const totalMonthly = c.alwaysOnMonthlyUsd + c.sinkMonthlyRiskUsd;
      const hasLargeFiles = tf.tokenSinks.length > 0;
      const hasSavings = c.potentialMonthlySavingsUsd > 0;
      const label = hasLargeFiles
        ? `Token Cost: ~$${totalMonthly.toFixed(2)}/mo/dev (Save ~$${c.potentialMonthlySavingsUsd.toFixed(2)}/mo)`
        : hasSavings
          ? `Token Cost: ~$${totalMonthly.toFixed(2)}/mo/dev (Trim Instructions)`
          : `Token Cost: ~$${totalMonthly.toFixed(2)}/mo/dev · Optimized`;

      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = `~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} tok/turn · ${c.modelLabel}`;
      item.iconPath = new vscode.ThemeIcon(
        hasSavings ? 'flame' : 'pass',
        hasSavings
          ? new vscode.ThemeColor('problemsWarningIcon.foreground')
          : new vscode.ThemeColor('testing.iconPassed')
      );
      item.contextValue = hasLargeFiles
        ? 'archpilot.tokenCost.hasSavings'
        : 'archpilot.tokenCost.clean';
      item.command = {
        command: 'archpilot.selectModelPreset',
        title: 'Select Model Pricing Preset',
      };

      const calcTier = (rate: number) =>
        (
          (tf.alwaysOnInstructionTokens * c.turnsPerMonth + tf.totalSinkTokens * 110) *
          rate /
          1_000_000
        ).toFixed(2);

      item.tooltip = [
        `Model Tier: ${c.modelLabel} (${c.turnsPerMonth.toLocaleString('en-US')} turns/mo)`,
        `Always-on instructions: ~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} tok/turn (~$${c.alwaysOnMonthlyUsd.toFixed(2)}/mo/dev)`,
        `Unignored token sinks: ${tf.tokenSinks.length} files / ~${tf.totalSinkTokens.toLocaleString('en-US')} tokens (~$${c.sinkMonthlyRiskUsd.toFixed(2)}/mo risk)`,
        hasSavings
          ? `Potential savings: ~$${c.potentialMonthlySavingsUsd.toFixed(2)}/mo/dev (~$${(c.potentialMonthlySavingsUsd * 10).toFixed(0)}/mo for a 10-dev team)`
          : 'No unignored token sinks detected.',
        '',
        '3-Tier Monthly Cost Comparison (per dev):',
        `• Fast / Flash ($0.30/1M): ~$${calcTier(0.3)}/mo`,
        `• Standard / Sonnet / GPT-4o ($3/1M): ~$${calcTier(3)}/mo`,
        `• Frontier / Opus ($15/1M): ~$${calcTier(15)}/mo`,
        '',
        'Click to change model pricing preset · Right-click to Reduce AI Token Cost',
      ].join('\n');
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
          { kind: 'tokenCost', audit: single },
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
      return [
        { kind: 'tokenCost', audit: element.audit },
        ...element.audit.report.categories.map(
          (category): TreeNode => ({
            kind: 'category',
            category,
            audit: element.audit,
          })
        ),
      ];
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
