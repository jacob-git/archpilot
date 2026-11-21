import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import {
  analyzeBlastRadius,
  analyzeMigration,
  formatHtmlReport,
  generateAgentsMd,
  generateMigrationPlanMd,
  generateMigrationWavePrompt,
  generatePrHandoffBrief,
  runDependencyAudit,
  suggestMigrationPlaybooks,
  type MigrationPlaybookId,
  type MigrationRuleConfig,
} from '@archpilot/core';
import { estimateModelRateUsd, getDetectedChatModels, type FolderAudit } from './types.js';

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
      label: `$(flame) Risk: ${br.riskLevel.toUpperCase()} (${br.changedFiles.length} changed, ${br.transitiveDependents.length} downstream, ${br.untestedImpactedFiles.length} untested)`,
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
    title: `ArchPilot Blast Radius & QA Test Gaps: ${audit.name}`,
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
    `Copied PR & QA Handoff Brief for ${audit.name}. Ready to paste into GitHub, GitLab, Bitbucket, or Jira.`,
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
      label: `$(shield) ${report.counts.total} CVEs (${report.counts.critical} Critical, ${report.counts.high} High, ${report.counts.moderate} Moderate, ${report.counts.low} Low)`,
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
    title: `ArchPilot Dependency CVE Audit: ${audit.name}`,
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
          `- **[${v.severity.toUpperCase()}] \`${v.packageName}\`** (${v.ecosystem}): ${v.title}${v.fixedVersion ? `: target version \`${v.fixedVersion}\`${v.isBreakingFix ? ' (major/breaking)' : ''}` : ''}`
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

export async function showMigrationPlanner(audit: FolderAudit): Promise<void> {
  const playbooks = await suggestMigrationPlaybooks(audit.rootDir);

  interface PlaybookPick extends vscode.QuickPickItem {
    playbookId?: MigrationPlaybookId;
    customRule?: MigrationRuleConfig;
    isAdHocCustom?: boolean;
  }

  const pickItems: PlaybookPick[] = [];
  const recommended = playbooks.filter((p) => p.recommended);
  const others = playbooks.filter((p) => !p.recommended);

  if (recommended.length > 0) {
    pickItems.push({ label: 'Recommended for this repository', kind: vscode.QuickPickItemKind.Separator });
    for (const p of recommended) {
      pickItems.push({
        label: `$(rocket) ${p.name}`,
        description: p.reason ?? '',
        detail: p.description,
        playbookId: p.id,
        customRule: p.customRule,
      });
    }
  }

  if (others.length > 0) {
    pickItems.push({ label: 'Other Built-In Upgrade Playbooks', kind: vscode.QuickPickItemKind.Separator });
    for (const p of others) {
      pickItems.push({
        label: `$(tools) ${p.name}`,
        detail: p.description,
        playbookId: p.id,
      });
    }
  }

  pickItems.push({ label: 'Custom Upgrade / Library Migration', kind: vscode.QuickPickItemKind.Separator });
  pickItems.push({
    label: '$(edit) Custom Migration Scan...',
    description: 'Search for any legacy import or code pattern',
    detail: 'Example: moment -> dayjs, legacy-auth-sdk -> auth-v2, or custom regex',
    playbookId: 'custom',
    isAdHocCustom: true,
  });

  const selected = await vscode.window.showQuickPick(pickItems, {
    title: `ArchPilot Upgrade & Migration Planner: ${audit.name}`,
    placeHolder: 'Choose an upgrade playbook or run a custom migration scan',
  });
  if (!selected || !selected.playbookId) return;

  let customRule = selected.customRule;
  if (selected.isAdHocCustom) {
    const name = await vscode.window.showInputBox({
      title: 'Custom Migration Name',
      prompt: 'Enter a short name for this upgrade (e.g. moment -> dayjs)',
      placeHolder: 'moment -> dayjs',
    });
    if (!name) return;
    const importInput = await vscode.window.showInputBox({
      title: 'Legacy Imports to Replace (optional)',
      prompt: 'Comma-separated legacy package/import names to flag (leave blank if using a code pattern)',
      placeHolder: 'moment, legacy-auth-sdk',
    });
    const patternInput = await vscode.window.showInputBox({
      title: 'Legacy Code Pattern Regex (optional)',
      prompt: 'Optional regex pattern to flag in source/config files',
      placeHolder: 'process\\.env\\.REACT_APP_',
    });
    const forbidImports = (importInput ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const forbidPatterns = patternInput?.trim() ? [patternInput.trim()] : [];
    if (forbidImports.length === 0 && forbidPatterns.length === 0) {
      void vscode.window.showWarningMessage('Enter at least one legacy import or regex pattern to scan.');
      return;
    }
    customRule = {
      name: name.trim(),
      forbidImports,
      forbidPatterns,
      suggestion: `Migrate legacy usage as part of "${name.trim()}".`,
    };
  }

  const plan = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ArchPilot: Scanning ${audit.name} for migration blockers...`,
      cancellable: false,
    },
    () => analyzeMigration(audit.rootDir, { playbookId: selected.playbookId!, customRule })
  );

  if (plan.totalBlockers === 0) {
    void vscode.window.showInformationMessage(
      `ArchPilot Migration Scan (${plan.name}): 0 blockers found in ${audit.name}.`
    );
    return;
  }

  interface PlanActionPick extends vscode.QuickPickItem {
    action?: 'writeMd' | 'aiWave1' | 'copyWave1' | 'openFile';
    relPath?: string;
    line?: number;
  }

  const resultItems: PlanActionPick[] = [
    {
      label: '$(markdown) Generate MIGRATION_PLAN.md',
      description: `${plan.totalBlockers} blockers across ${plan.impactedFileCount} files (${plan.estimatedEffort} effort)`,
      action: 'writeMd',
    },
    {
      label: '$(comment-discussion) Send Wave 1 to AI Chat',
      description: `Migrate ${plan.waves[0]?.files.length ?? 0} safest files first`,
      action: 'aiWave1',
    },
    {
      label: '$(copy) Copy Wave 1 AI Prompt',
      description: 'Paste into Copilot, Cursor, Claude, or any agent',
      action: 'copyWave1',
    },
  ];

  for (const wave of plan.waves) {
    resultItems.push({
      label: `${wave.label} (${wave.files.length} files)`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const wf of wave.files.slice(0, 15)) {
      const first = wf.blockers[0];
      resultItems.push({
        label: `$(warning) ${wf.file}`,
        description: `${wf.blockerCount} blocker${wf.blockerCount === 1 ? '' : 's'} · ${wf.dependentCount} dep${wf.dependentCount === 1 ? '' : 's'}`,
        detail: first ? `${first.line ? `L${first.line}: ` : ''}${first.message}` : undefined,
        action: 'openFile',
        relPath: wf.file,
        line: first?.line,
      });
    }
  }

  const chosen = await vscode.window.showQuickPick(resultItems, {
    title: `${plan.name}: ${plan.totalBlockers} blockers in ${plan.impactedFileCount} files`,
    placeHolder: 'Generate MIGRATION_PLAN.md, send Wave 1 to AI Chat, or open a file',
  });
  if (!chosen) return;

  if (chosen.action === 'writeMd') {
    const target = path.join(audit.rootDir, 'MIGRATION_PLAN.md');
    await writeFile(target, generateMigrationPlanMd(plan), 'utf8');
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
  } else if (chosen.action === 'aiWave1') {
    const prompt = generateMigrationWavePrompt(plan, plan.waves[0]?.wave);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage('Copied Wave 1 migration prompt to clipboard.');
    }
  } else if (chosen.action === 'copyWave1') {
    await vscode.env.clipboard.writeText(generateMigrationWavePrompt(plan, plan.waves[0]?.wave));
    void vscode.window.showInformationMessage('Copied Wave 1 migration prompt to clipboard.');
  } else if (chosen.action === 'openFile' && chosen.relPath) {
    const fullPath = path.join(audit.rootDir, chosen.relPath);
    if (await fileExists(fullPath)) {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      const editor = await vscode.window.showTextDocument(doc);
      if (chosen.line && chosen.line > 0) {
        const pos = new vscode.Position(chosen.line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
  }
}

export async function generateOrUpdateAgentsMd(rootDir: string): Promise<boolean> {
  const target = path.join(rootDir, 'AGENTS.md');
  const freshContent = await generateAgentsMd(rootDir);

  if (!(await fileExists(target))) {
    await writeFile(target, freshContent, 'utf8');
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
    return true;
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(comment-discussion) Update with AI Chat (Preserve Custom Rules)',
        description: 'Recommended',
        detail: 'Merges newly detected stack, scripts, and structure into your existing AGENTS.md',
        action: 'aiMerge' as const,
      },
      {
        label: '$(refresh) Replace with Fresh Generated AGENTS.md',
        detail: 'Overwrites AGENTS.md with a clean template scanned from the current repo',
        action: 'replace' as const,
      },
      {
        label: '$(go-to-file) Open Current AGENTS.md',
        detail: 'Review or edit the existing file manually',
        action: 'open' as const,
      },
    ],
    {
      title: `AGENTS.md already exists in ${path.basename(rootDir)}`,
      placeHolder: 'Choose how to update AGENTS.md',
    }
  );
  if (!picked) return false;

  if (picked.action === 'open') {
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
    return false;
  }

  if (picked.action === 'replace') {
    await writeFile(target, freshContent, 'utf8');
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage('Replaced AGENTS.md with a freshly generated template.');
    return true;
  }

  const existing = await readFile(target, 'utf8');
  const prompt = [
    `Please update \`AGENTS.md\` in **${path.basename(rootDir)}** so it reflects the current repository structure, scripts, and stack while preserving all custom team rules and conventions.`,
    '',
    'Keep the updated file concise (under 2,500 tokens) and remove any stale file paths or dead npm scripts.',
    '',
    '### Freshly detected repository overview:',
    '```markdown',
    freshContent.trim(),
    '```',
    '',
    '### Current AGENTS.md:',
    '```markdown',
    existing.slice(0, 6000).trim(),
    '```',
  ].join('\n');

  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
  } catch {
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showInformationMessage('Copied AGENTS.md update prompt to clipboard.');
  }
  return false;
}

export async function selectModelPresetPicker(): Promise<boolean> {
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
    { label: 'General Pricing Tiers', kind: vscode.QuickPickItemKind.Separator, rate: 0, short: '' },
    { label: 'Fast / Flash / Mini', description: '$0.30/1M input (Gemini Flash, GPT-4o-mini, o4-mini)', rate: 0.3, short: 'Fast ($0.30/1M)' },
    { label: 'Standard / Sonnet / GPT-4o', description: '$3/1M input (Claude Sonnet, GPT-4o, GPT-4.1)', rate: 3, short: 'Standard ($3/1M)' },
    { label: 'High-Reasoning / GPT-5+ / o3', description: '$5/1M input (GPT-5, GPT-6, o3)', rate: 5, short: 'Reasoning ($5/1M)' },
    { label: 'Frontier / Opus', description: '$15/1M input (Claude Opus)', rate: 15, short: 'Frontier ($15/1M)' },
    { label: 'Custom rate...', description: 'Enter any exact $ per 1M input token price', rate: -1, short: 'Custom' }
  );

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a detected Copilot/VS Code model or pricing tier',
  });
  if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) return false;

  let rate = picked.rate;
  let shortLabel = picked.short;
  if (rate < 0) {
    const raw = await vscode.window.showInputBox({
      prompt: 'Enter input token cost in USD per 1M tokens (e.g., 2.5)',
      value: '3',
      validateInput: (v) => (Number(v) > 0 ? undefined : 'Enter a positive number'),
    });
    if (!raw) return false;
    rate = Number(raw);
    shortLabel = `Custom ($${rate}/1M)`;
  }

  const cfg = vscode.workspace.getConfiguration('archpilot');
  await cfg.update('costPerMillionInputTokens', rate, vscode.ConfigurationTarget.Global);
  await cfg.update('modelPresetLabel', shortLabel, vscode.ConfigurationTarget.Global);
  return true;
}
