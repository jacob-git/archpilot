import * as vscode from 'vscode';
import type { AuditReport, CategoryScore, Finding } from '@archpilot/core';

export interface FolderAudit {
  name: string;
  rootDir: string;
  report: AuditReport;
}

export type TreeNode =
  | { kind: 'folder'; audit: FolderAudit }
  | { kind: 'summary'; audit: FolderAudit }
  | { kind: 'tokenCost'; audit: FolderAudit }
  | { kind: 'category'; category: CategoryScore; audit: FolderAudit }
  | { kind: 'finding'; finding: Finding; audit: FolderAudit };

export interface LiveChatModel {
  id: string;
  name?: string;
  family?: string;
  vendor?: string;
}

export const DETERMINISTIC_FIXABLE_RULES = new Set([
  'missing-agent-instructions',
  'no-boundary-rules',
  'missing-gitignore',
]);

export function findingContextValue(finding: Finding): string {
  const fixable = DETERMINISTIC_FIXABLE_RULES.has(finding.id) ? '.fixable' : '';
  const hasFile = finding.file ? '.file' : '';
  return `archpilot.finding${fixable}${hasFile}`;
}

export function formatStackTags(report: AuditReport): string {
  const tags = [
    ...report.detectedStack.languages,
    ...report.detectedStack.frameworks,
    ...report.detectedStack.capabilities,
  ];
  return tags.length > 0 ? tags.join(' · ') : 'generic';
}

export function formatTokenLine(report: AuditReport): string {
  const tf = report.tokenFootprint;
  const sinks =
    tf.tokenSinks.length > 0
      ? `${tf.tokenSinks.length} token sinks (~${tf.totalSinkTokens.toLocaleString('en-US')} tokens)`
      : '0 unignored token sinks';
  return `~${tf.alwaysOnInstructionTokens.toLocaleString('en-US')} always-on tokens/turn · ${sinks}`;
}

export function estimateModelRateUsd(idOrName: string): number {
  const s = idOrName.toLowerCase();
  if (s.includes('opus')) return 15;
  if (s.includes('o1-pro')) return 15;
  if (s.includes('haiku')) return 0.8;
  if (s.includes('flash') || s.includes('mini') || s.includes('nano') || s.includes('lite')) {
    return 0.3;
  }
  if (s.includes('sonnet')) return 3;
  if (s.includes('gpt-4.1')) return 2;
  if (s.includes('gpt-4o')) return 2.5;
  if (s.includes('gpt-5') || s.includes('gpt-6') || /\bo[134]\b/.test(s)) return 5;
  if (s.includes('gemini') && s.includes('pro')) return 1.25;
  return 3;
}

export async function getDetectedChatModels(): Promise<LiveChatModel[]> {
  try {
    const lm = (
      vscode as unknown as {
        lm?: { selectChatModels?: () => Promise<LiveChatModel[]> };
      }
    ).lm;
    if (!lm?.selectChatModels) return [];
    const models = await lm.selectChatModels();
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}
