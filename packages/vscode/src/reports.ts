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
import { openInspectorPanel, type InspectorAction, type InspectorSection, type InspectorViewModel } from './reportView.js';

async function openRelFile(rootDir: string, relPath: string, line?: number): Promise<void> {
  const full = path.join(rootDir, relPath);
  if (!(await fileExists(full))) {
    void vscode.window.showInformationMessage(`"${relPath}" no longer exists on disk.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(full);
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  if (line && line > 0) {
    const pos = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

async function sendPromptToAiChat(prompt: string, fallbackLabel: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
  } catch {
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showInformationMessage(`Copied ${fallbackLabel} prompt to clipboard.`);
  }
}

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

  const sections: InspectorSection[] = [
    {
      title: `Changed Files (${br.changedFiles.length})`,
      rows: br.changedFiles.map((f) => ({
        title: f,
        badge: { text: 'Changed', tone: 'info' },
        actions: [{ id: 'open', label: 'Open', payload: f }],
      })),
    },
    {
      title: `Untested Impacted Files (${br.untestedImpactedFiles.length})`,
      subtitle: 'QA coverage gaps',
      rows: br.untestedImpactedFiles.map((f) => ({
        title: f,
        badge: { text: 'Untested', tone: 'warn' },
        detail: 'No matching unit test found for this changed/impacted file.',
        actions: [{ id: 'open', label: 'Open', payload: f }],
      })),
    },
    {
      title: `Recommended Tests to Run (${br.impactedTestsToRun.length})`,
      rows: br.impactedTestsToRun.map((f) => ({
        title: f,
        badge: { text: 'Test', tone: 'ok' },
        actions: [{ id: 'open', label: 'Open', payload: f }],
      })),
    },
    {
      title: `Downstream Impacted Files (${br.transitiveDependents.length})`,
      rows: br.transitiveDependents.map((f) => ({
        title: f,
        badge: {
          text: br.directDependents.includes(f) ? 'Direct' : 'Transitive',
          tone: br.directDependents.includes(f) ? 'warn' : 'info',
        },
        actions: [{ id: 'open', label: 'Open', payload: f }],
      })),
    },
    {
      title: `Guardrail Findings in Changed Files (${br.diffFindings.length})`,
      rows: br.diffFindings.map((f) => ({
        title: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : f.id,
        badge: { text: f.id, tone: f.severity === 'error' ? 'error' : 'warn' },
        detail: f.message,
        actions: f.file ? [{ id: 'open', label: 'Open', payload: `${f.file}::${f.line ?? 0}` }] : [],
      })),
    },
  ];

  const riskTone = br.riskLevel === 'high' ? 'error' : br.riskLevel === 'medium' ? 'warn' : 'ok';
  const headerActions = [
    { id: 'copyPrBrief', label: 'Copy PR & QA Brief', primary: br.untestedImpactedFiles.length === 0 },
  ];
  if (br.untestedImpactedFiles.length > 0) {
    headerActions.unshift({
      id: 'genTests',
      label: `Generate Missing Tests (${br.untestedImpactedFiles.length})`,
      primary: true,
    });
  }

  openInspectorPanel(
    {
      viewId: `blast-${audit.rootDir}`,
      tabTitle: `Blast Radius: ${audit.name}`,
      heading: `Git Diff & Blast Radius: ${audit.name}`,
      subheading: `${br.impactedModules.length} impacted module${br.impactedModules.length === 1 ? '' : 's'}`,
      metrics: [
        { label: 'Change Risk', value: br.riskLevel.toUpperCase(), tone: riskTone },
        { label: 'Changed Files', value: String(br.changedFiles.length) },
        { label: 'Downstream Impact', value: String(br.transitiveDependents.length), tone: br.transitiveDependents.length > 0 ? 'warn' : 'ok' },
        { label: 'Untested QA Gaps', value: String(br.untestedImpactedFiles.length), tone: br.untestedImpactedFiles.length > 0 ? 'warn' : 'ok' },
      ],
      headerActions,
      sections,
    },
    async (actionId, payload) => {
      if (actionId === 'genTests') {
        const prompt = [
          `Please write focused unit tests for these changed/impacted files in **${audit.name}** that currently have no matching test coverage:`,
          '',
          ...br.untestedImpactedFiles.slice(0, 15).map((f) => `- \`${f}\``),
          '',
          'Use deterministic assertions (no hardcoded sleeps/timeouts) and verify all tests pass.',
        ].join('\n');
        await sendPromptToAiChat(prompt, 'test-generation');
      } else if (actionId === 'copyPrBrief') {
        await generateAndCopyPrBrief(audit);
      } else if (actionId === 'open' && payload) {
        const [rel, lineStr] = payload.split('::');
        await openRelFile(audit.rootDir, rel, lineStr ? Number(lineStr) : undefined);
      }
    }
  );
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

  const buildModel = async (): Promise<{
    model: InspectorViewModel;
    report: Awaited<ReturnType<typeof runDependencyAudit>>;
  }> => {
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ArchPilot: Auditing dependency CVEs for ${audit.name}...`,
        cancellable: false,
      },
      () => runDependencyAudit(audit.rootDir, { npmRegistry })
    );

    const hasSafeNpmFix = report.vulnerabilities.some(
      (v) => v.ecosystem === 'npm' && v.fixAvailable && !v.isBreakingFix
    );
    const headerActions: InspectorAction[] = [{ id: 'rescan', label: 'Rescan CVEs' }];
    if (report.vulnerabilities.length > 0) {
      headerActions.unshift({ id: 'aiChat', label: 'Fix All with AI Chat' });
    }
    if (hasSafeNpmFix) {
      headerActions.unshift({ id: 'npmFix', label: 'Run Safe npm audit fix', primary: true });
    }

    const subheading = report.usedPublicFallback
      ? 'Audited via public registry.npmjs.org fallback'
      : report.notes[0] ?? `Registry: ${report.registryUsed ?? 'default npm registry'}`;

    const model: InspectorViewModel = {
      viewId: `cve-${audit.rootDir}`,
      tabTitle: `CVE Audit: ${audit.name}`,
      heading: `Dependency Vulnerability Audit: ${audit.name}`,
      subheading,
      metrics: [
        { label: 'Total CVEs', value: String(report.counts.total), tone: report.counts.total > 0 ? 'error' : 'ok' },
        { label: 'Critical', value: String(report.counts.critical), tone: report.counts.critical > 0 ? 'error' : 'ok' },
        { label: 'High', value: String(report.counts.high), tone: report.counts.high > 0 ? 'error' : 'ok' },
        { label: 'Moderate', value: String(report.counts.moderate), tone: report.counts.moderate > 0 ? 'warn' : 'ok' },
        { label: 'Low', value: String(report.counts.low) },
      ],
      headerActions,
      emptyMessage: `0 known dependency vulnerabilities detected in ${audit.name}.`,
      sections: [
        {
          title: `Vulnerable Packages (${report.vulnerabilities.length})`,
          rows: report.vulnerabilities.map((v) => {
            const fixNote = v.fixAvailable
              ? v.isBreakingFix
                ? `breaking fix${v.fixedVersion ? ` -> ${v.fixedVersion}` : ''}`
                : `safe fix${v.fixedVersion ? ` -> ${v.fixedVersion}` : ''}`
              : 'no auto-fix';
            return {
              title: v.packageName,
              badge: {
                text: v.severity,
                tone: v.severity === 'critical' || v.severity === 'high' ? 'error' : 'warn',
              },
              meta: `${v.ecosystem} · ${fixNote}`,
              detail: v.title,
              actions: v.url ? [{ id: 'openUrl', label: 'Advisory', payload: v.url }] : [],
            };
          }),
        },
      ],
    };

    return { model, report };
  };

  let state = await buildModel();
  openInspectorPanel(state.model, async (actionId, payload) => {
    const registryFlag = state.report.registryUsed ? ` --registry=${state.report.registryUsed}` : '';
    if (actionId === 'npmFix') {
      const term = vscode.window.createTerminal({
        name: `ArchPilot: npm audit fix (${audit.name})`,
        cwd: audit.rootDir,
      });
      term.show();
      term.sendText(`npm audit fix${registryFlag}`);
    } else if (actionId === 'aiChat') {
      const prompt = [
        `Please remediate these dependency security vulnerabilities (CVEs) in **${audit.name}** safely (update versions, adjust any breaking API changes, and verify build & tests pass):`,
        '',
        ...state.report.vulnerabilities.slice(0, 20).map(
          (v) =>
            `- **[${v.severity.toUpperCase()}] \`${v.packageName}\`** (${v.ecosystem}): ${v.title}${v.fixedVersion ? `: target version \`${v.fixedVersion}\`${v.isBreakingFix ? ' (major/breaking)' : ''}` : ''}`
        ),
      ].join('\n');
      await sendPromptToAiChat(prompt, 'CVE remediation');
    } else if (actionId === 'openUrl' && payload) {
      await vscode.env.openExternal(vscode.Uri.parse(payload));
    } else if (actionId === 'rescan') {
      state = await buildModel();
      return state.model;
    }
  });
}

export async function showMigrationPlanner(audit: FolderAudit): Promise<void> {
  const playbooks = await suggestMigrationPlaybooks(audit.rootDir);
  let activePlan: Awaited<ReturnType<typeof analyzeMigration>> | undefined;

  const buildPlaybookListModel = (): InspectorViewModel => {
    const recommended = playbooks.filter((p) => p.recommended);
    const others = playbooks.filter((p) => !p.recommended);
    const sections: InspectorSection[] = [];
    if (recommended.length > 0) {
      sections.push({
        title: 'Recommended for This Repository',
        rows: recommended.map((p, i) => ({
          title: p.name,
          badge: { text: 'Recommended', tone: 'ok' },
          meta: p.reason,
          detail: p.description,
          actions: [{ id: 'runPlaybook', label: 'Run Scan', primary: true, payload: `rec::${i}` }],
        })),
      });
    }
    if (others.length > 0) {
      sections.push({
        title: 'Other Built-In Upgrade Playbooks',
        rows: others.map((p, i) => ({
          title: p.name,
          detail: p.description,
          actions: [{ id: 'runPlaybook', label: 'Run Scan', payload: `oth::${i}` }],
        })),
      });
    }
    sections.push({
      title: 'Custom Library or Framework Migration',
      rows: [
        {
          title: 'Custom Migration Scan...',
          detail: 'Flag any legacy import or regex pattern (e.g., moment -> dayjs, legacy-auth-sdk -> auth-v2)',
          actions: [{ id: 'runCustom', label: 'Configure & Scan' }],
        },
      ],
    });
    return {
      viewId: `migration-${audit.rootDir}`,
      tabTitle: `Upgrade Planner: ${audit.name}`,
      heading: `Upgrade & Migration Readiness Planner: ${audit.name}`,
      subheading: 'Choose a playbook to scan blockers and generate dependency-ordered migration waves',
      metrics: [
        { label: 'Recommended', value: String(recommended.length), tone: recommended.length > 0 ? 'ok' : 'default' },
        { label: 'Built-In Playbooks', value: String(playbooks.length) },
      ],
      sections,
    };
  };

  const buildPlanModel = (plan: Awaited<ReturnType<typeof analyzeMigration>>): InspectorViewModel => {
    const effortTone =
      plan.estimatedEffort === 'high' ? 'error' : plan.estimatedEffort === 'medium' ? 'warn' : 'ok';
    const headerActions: InspectorAction[] = [{ id: 'back', label: 'All Playbooks' }];
    if (plan.totalBlockers > 0) {
      headerActions.push(
        { id: 'writeMd', label: 'Generate MIGRATION_PLAN.md', primary: true },
        { id: 'aiWave1', label: `Send Wave 1 to AI Chat (${plan.waves[0]?.files.length ?? 0} files)` },
        { id: 'copyWave1', label: 'Copy Wave 1 Prompt' }
      );
    }
    return {
      viewId: `migration-${audit.rootDir}`,
      tabTitle: `Migration: ${audit.name}`,
      heading: `Upgrade Plan: ${plan.name}`,
      subheading: plan.description,
      metrics: [
        { label: 'Total Blockers', value: String(plan.totalBlockers), tone: plan.totalBlockers > 0 ? 'warn' : 'ok' },
        { label: 'Impacted Files', value: String(plan.impactedFileCount) },
        { label: 'Waves', value: String(plan.waves.length) },
        { label: 'Effort', value: plan.estimatedEffort.toUpperCase(), tone: effortTone },
      ],
      headerActions,
      emptyMessage: `0 migration blockers found in ${audit.name} for "${plan.name}".`,
      sections: plan.waves.map((wave) => ({
        title: `${wave.label} (${wave.files.length} files)`,
        subtitle: wave.description,
        rows: wave.files.slice(0, 30).map((wf) => {
          const first = wf.blockers[0];
          return {
            title: wf.file,
            badge: {
              text: `${wf.blockerCount} blocker${wf.blockerCount === 1 ? '' : 's'}`,
              tone: first?.severity === 'error' ? 'error' : 'warn',
            },
            meta: `${wf.dependentCount} dependent${wf.dependentCount === 1 ? '' : 's'}`,
            detail: first ? `${first.line ? `L${first.line}: ` : ''}${first.message} -> ${first.suggestion}` : undefined,
            actions: [{ id: 'open', label: 'Open', payload: `${wf.file}::${first?.line ?? 0}` }],
          };
        }),
      })),
    };
  };

  const recommended = playbooks.filter((p) => p.recommended);
  const others = playbooks.filter((p) => !p.recommended);

  openInspectorPanel(buildPlaybookListModel(), async (actionId, payload) => {
    if (actionId === 'back') {
      activePlan = undefined;
      return buildPlaybookListModel();
    }
    if (actionId === 'runPlaybook' && payload) {
      const [group, idxStr] = payload.split('::');
      const pb = (group === 'rec' ? recommended : others)[Number(idxStr)];
      if (!pb) return;
      activePlan = await analyzeMigration(audit.rootDir, {
        playbookId: pb.id,
        customRule: pb.customRule,
      });
      return buildPlanModel(activePlan);
    }
    if (actionId === 'runCustom') {
      const name = await vscode.window.showInputBox({
        title: 'Custom Migration Name',
        prompt: 'Enter a short name for this upgrade (e.g. moment -> dayjs)',
        placeHolder: 'moment -> dayjs',
      });
      if (!name) return;
      const importInput = await vscode.window.showInputBox({
        title: 'Legacy Imports to Replace (optional)',
        prompt: 'Comma-separated legacy package/import names to flag',
        placeHolder: 'moment, legacy-auth-sdk',
      });
      const patternInput = await vscode.window.showInputBox({
        title: 'Legacy Code Pattern Regex (optional)',
        prompt: 'Optional regex pattern to flag in source/config files',
        placeHolder: 'process\\.env\\.REACT_APP_',
      });
      const forbidImports = (importInput ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const forbidPatterns = patternInput?.trim() ? [patternInput.trim()] : [];
      if (forbidImports.length === 0 && forbidPatterns.length === 0) {
        void vscode.window.showWarningMessage('Enter at least one legacy import or regex pattern.');
        return;
      }
      activePlan = await analyzeMigration(audit.rootDir, {
        playbookId: 'custom',
        customRule: {
          name: name.trim(),
          forbidImports,
          forbidPatterns,
          suggestion: `Migrate legacy usage as part of "${name.trim()}".`,
        },
      });
      return buildPlanModel(activePlan);
    }
    if (actionId === 'writeMd' && activePlan) {
      const target = path.join(audit.rootDir, 'MIGRATION_PLAN.md');
      await writeFile(target, generateMigrationPlanMd(activePlan), 'utf8');
      await openRelFile(audit.rootDir, 'MIGRATION_PLAN.md');
    } else if (actionId === 'aiWave1' && activePlan) {
      await sendPromptToAiChat(
        generateMigrationWavePrompt(activePlan, activePlan.waves[0]?.wave),
        'Wave 1 migration'
      );
    } else if (actionId === 'copyWave1' && activePlan) {
      await vscode.env.clipboard.writeText(
        generateMigrationWavePrompt(activePlan, activePlan.waves[0]?.wave)
      );
      void vscode.window.showInformationMessage('Copied Wave 1 migration prompt to clipboard.');
    } else if (actionId === 'open' && payload) {
      const [rel, lineStr] = payload.split('::');
      await openRelFile(audit.rootDir, rel, lineStr ? Number(lineStr) : undefined);
    }
  });
}

export async function generateOrUpdateAgentsMd(
  rootDir: string,
  onUpdated?: () => Promise<void>
): Promise<boolean> {
  const target = path.join(rootDir, 'AGENTS.md');
  const freshContent = await generateAgentsMd(rootDir);

  if (!(await fileExists(target))) {
    await writeFile(target, freshContent, 'utf8');
    await openRelFile(rootDir, 'AGENTS.md');
    if (onUpdated) await onUpdated();
    return true;
  }

  const existing = await readFile(target, 'utf8');
  const existingTokens = Math.ceil(existing.length / 4);
  const freshTokens = Math.ceil(freshContent.length / 4);
  const repoName = path.basename(rootDir);

  openInspectorPanel(
    {
      viewId: `agents-${rootDir}`,
      tabTitle: `AGENTS.md: ${repoName}`,
      heading: `Update AGENTS.md: ${repoName}`,
      subheading: 'AGENTS.md already exists in this repository. Choose how you want to update it.',
      metrics: [
        { label: 'Current Size', value: `~${existingTokens.toLocaleString('en-US')} tok`, tone: existingTokens > 3000 ? 'warn' : 'ok' },
        { label: 'Fresh Template', value: `~${freshTokens.toLocaleString('en-US')} tok`, tone: 'ok' },
      ],
      sections: [
        {
          title: 'Update Options',
          rows: [
            {
              title: 'Update with AI Chat (Preserve Custom Rules)',
              badge: { text: 'Recommended', tone: 'ok' },
              detail: 'Merges newly detected stack, scripts, and structure into your existing AGENTS.md without losing custom conventions.',
              actions: [{ id: 'aiMerge', label: 'Open AI Chat', primary: true }],
            },
            {
              title: 'Replace with Fresh Generated AGENTS.md',
              detail: 'Overwrites AGENTS.md with a clean template scanned from the current repository.',
              actions: [{ id: 'replace', label: 'Replace File' }],
            },
            {
              title: 'Open Current AGENTS.md',
              detail: 'Review or edit the existing file manually in the editor.',
              actions: [{ id: 'open', label: 'Open File' }],
            },
          ],
        },
      ],
    },
    async (actionId) => {
      if (actionId === 'open') {
        await openRelFile(rootDir, 'AGENTS.md');
      } else if (actionId === 'replace') {
        await writeFile(target, freshContent, 'utf8');
        await openRelFile(rootDir, 'AGENTS.md');
        void vscode.window.showInformationMessage('Replaced AGENTS.md with a freshly generated template.');
        if (onUpdated) await onUpdated();
      } else if (actionId === 'aiMerge') {
        const prompt = [
          `Please update \`AGENTS.md\` in **${repoName}** so it reflects the current repository structure, scripts, and stack while preserving all custom team rules and conventions.`,
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
        await sendPromptToAiChat(prompt, 'AGENTS.md update');
      }
    }
  );
  return false;
}

export async function selectModelPresetPicker(onChanged?: () => Promise<void>): Promise<void> {
  const buildModel = async (): Promise<InspectorViewModel> => {
    const cfg = vscode.workspace.getConfiguration('archpilot');
    const activeRate = cfg.get<number>('costPerMillionInputTokens', 3);
    const activeLabel = cfg.get<string>('modelPresetLabel', `Standard ($${activeRate}/1M)`);

    const liveModels = await getDetectedChatModels();
    const seen = new Set<string>();
    const detectedRows = [];
    for (const m of liveModels) {
      const displayName = m.name || m.family || m.id;
      const key = displayName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const rate = estimateModelRateUsd(`${m.id} ${m.name ?? ''} ${m.family ?? ''}`);
      const short = `${displayName} ($${rate}/1M)`;
      detectedRows.push({
        title: displayName,
        badge: activeLabel === short ? { text: 'Active', tone: 'ok' as const } : undefined,
        meta: `~$${rate}/1M input${m.vendor ? ` · ${m.vendor}` : ''}`,
        actions: [{ id: 'pick', label: 'Select', primary: activeLabel !== short, payload: `${rate}::${short}` }],
      });
    }

    const tiers = [
      { title: 'Fast / Flash / Mini', detail: 'Gemini Flash, GPT-4o-mini, o4-mini', rate: 0.3, short: 'Fast ($0.30/1M)' },
      { title: 'Standard / Sonnet / GPT-4o', detail: 'Claude Sonnet, GPT-4o, GPT-4.1', rate: 3, short: 'Standard ($3/1M)' },
      { title: 'High-Reasoning / GPT-5+ / o3', detail: 'GPT-5, GPT-6, o3', rate: 5, short: 'Reasoning ($5/1M)' },
      { title: 'Frontier / Opus', detail: 'Claude Opus', rate: 15, short: 'Frontier ($15/1M)' },
    ];

    const sections: InspectorSection[] = [];
    if (detectedRows.length > 0) {
      sections.push({ title: 'Detected in VS Code / Copilot', rows: detectedRows });
    }
    sections.push({
      title: 'General Pricing Tiers',
      rows: [
        ...tiers.map((t) => ({
          title: t.title,
          badge: activeLabel === t.short ? { text: 'Active', tone: 'ok' as const } : undefined,
          meta: `$${t.rate}/1M input`,
          detail: t.detail,
          actions: [{ id: 'pick', label: 'Select', payload: `${t.rate}::${t.short}` }],
        })),
        {
          title: 'Custom Rate...',
          detail: 'Enter any exact USD per 1M input token price',
          actions: [{ id: 'custom', label: 'Enter Custom Rate' }],
        },
      ],
    });

    return {
      viewId: 'archpilot-model-pricing',
      tabTitle: 'Model Pricing Preset',
      heading: 'AI Model Pricing Preset',
      subheading: 'Used to estimate monthly token costs and savings across your repositories',
      metrics: [
        { label: 'Active Preset', value: activeLabel, tone: 'info' },
        { label: 'Rate / 1M Input Tokens', value: `$${activeRate}` },
      ],
      sections,
    };
  };

  openInspectorPanel(await buildModel(), async (actionId, payload) => {
    const cfg = vscode.workspace.getConfiguration('archpilot');
    if (actionId === 'pick' && payload) {
      const [rateStr, ...rest] = payload.split('::');
      const rate = Number(rateStr);
      const shortLabel = rest.join('::');
      await cfg.update('costPerMillionInputTokens', rate, vscode.ConfigurationTarget.Global);
      await cfg.update('modelPresetLabel', shortLabel, vscode.ConfigurationTarget.Global);
      if (onChanged) await onChanged();
      return buildModel();
    }
    if (actionId === 'custom') {
      const raw = await vscode.window.showInputBox({
        prompt: 'Enter input token cost in USD per 1M tokens (e.g., 2.5)',
        value: '3',
        validateInput: (v) => (Number(v) > 0 ? undefined : 'Enter a positive number'),
      });
      if (!raw) return;
      const rate = Number(raw);
      const shortLabel = `Custom ($${rate}/1M)`;
      await cfg.update('costPerMillionInputTokens', rate, vscode.ConfigurationTarget.Global);
      await cfg.update('modelPresetLabel', shortLabel, vscode.ConfigurationTarget.Global);
      if (onChanged) await onChanged();
      return buildModel();
    }
  });
}
